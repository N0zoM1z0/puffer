use super::*;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn session_for_path(cwd: &std::path::Path) -> SessionMetadata {
    SessionMetadata {
        id: Uuid::new_v4(),
        display_name: None,
        generated_title: None,
        cwd: cwd.to_path_buf(),
        created_at_ms: 0,
        updated_at_ms: 0,
        parent_session_id: None,
        slug: None,
        tags: Vec::new(),
        note: None,
    }
}

fn spawn_json_server<F>(
    expected_requests: usize,
    response_body: F,
) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>)
where
    F: Fn(usize) -> String + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let request_log = Arc::clone(&requests);
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut handled = 0_usize;
        while handled < expected_requests && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = vec![0_u8; 65_536];
                    let bytes = stream.read(&mut buffer).unwrap();
                    request_log
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buffer[..bytes]).to_string());
                    let body = response_body(handled);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    stream.write_all(response.as_bytes()).unwrap();
                    handled += 1;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("listener accept failed: {error}"),
            }
        }
    });
    (format!("http://{address}"), requests, server)
}

fn request_body(raw: &str) -> &str {
    raw.split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("")
}

#[test]
fn anthropic_agent_loop_returns_single_tool_errors_as_tool_results() {
    let temp = tempfile::tempdir().unwrap();
    let missing_path = temp.path().join("README.md");
    let missing_json = missing_path.to_string_lossy().to_string();
    let (base_url, requests, server) = spawn_json_server(2, move |index| {
        if index == 0 {
            json!({
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "call_missing_readme",
                    "name": "Read",
                    "input": { "file_path": missing_json }
                }],
                "stop_reason": "tool_use"
            })
            .to_string()
        } else {
            json!({
                "id": "msg_2",
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "text", "text": "continued after missing file" }],
                "stop_reason": "end_turn"
            })
            .to_string()
        }
    });

    let mut descriptor = provider();
    descriptor.id = "local-anthropic".to_string();
    descriptor.base_url = base_url;
    descriptor.auth_modes.clear();
    descriptor.models[0].provider = "local-anthropic".to_string();
    let mut registry = ProviderRegistry::new();
    registry.register(descriptor);
    let mut state = AppState::new(
        PufferConfig::default(),
        temp.path().to_path_buf(),
        session_for_path(temp.path()),
    );
    state.current_provider = Some("local-anthropic".to_string());
    state.current_model = Some("local-anthropic/claude-sonnet-4-5".to_string());
    state.session_allow_all = true;
    let resources = LoadedResources {
        tools: vec![loaded_tool("Read", "Read file", "runtime:claude_read")],
        ..LoadedResources::default()
    };

    let turn = execute_user_prompt(
        &mut state,
        &resources,
        &registry,
        &mut AuthStore::default(),
        "summarize this repo",
    )
    .unwrap();
    server.join().unwrap();

    assert_eq!(turn.assistant_text, "continued after missing file");
    assert_eq!(turn.tool_invocations.len(), 1);
    assert_eq!(turn.tool_invocations[0].tool_id, "Read");
    assert!(!turn.tool_invocations[0].success);
    assert!(turn.tool_invocations[0]
        .output
        .contains("Tool execution failed:"));

    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 2, "expected retry turn after tool error");
    let body2 = request_body(&captured[1]);
    let body2_json: Value = serde_json::from_str(body2).unwrap_or(Value::Null);
    let messages = body2_json
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages array on second Anthropic request");
    let has_error_result = messages.iter().any(|message| {
        message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks.iter().any(|block| {
                    block.get("type").and_then(Value::as_str) == Some("tool_result")
                        && block.get("tool_use_id").and_then(Value::as_str)
                            == Some("call_missing_readme")
                        && block.get("is_error").and_then(Value::as_bool) == Some(true)
                })
            })
            .unwrap_or(false)
    });
    assert!(
        has_error_result,
        "second request must carry missing-file tool_result error: {body2}"
    );
}
