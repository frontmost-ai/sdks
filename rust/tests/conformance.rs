// The eleven cases in conformance/README.md. conformance/run.mjs sets FRONTMOST_BASE_URL to the mock.
// The cases share one mock, so one test runs them in order.

use std::time::Duration;

use frontmost_ai::{
    Client, ClientOptions, ErrorKind, ProfilesCreateBody, ProjectsCreateBody, QuestionsCreateBody,
    QuestionsCreateBodyQuestion,
};
use serde_json::Value;

struct Mock {
    root: String,
    http: reqwest::Client,
}

impl Mock {
    async fn log(&self) -> Vec<Value> {
        let res = self
            .http
            .get(format!("{}/__log", self.root))
            .send()
            .await
            .unwrap();
        serde_json::from_slice(&res.bytes().await.unwrap()).unwrap()
    }

    async fn reset(&self) {
        self.http
            .post(format!("{}/__reset", self.root))
            .send()
            .await
            .unwrap();
    }
}

fn header<'a>(r: &'a Value, name: &str) -> Option<&'a str> {
    r["headers"][name].as_str()
}

#[tokio::test]
async fn conformance() {
    let base = std::env::var("FRONTMOST_BASE_URL")
        .expect("run this through node conformance/run.mjs rust");
    let mock = Mock {
        root: base.trim_end_matches("/v1").to_string(),
        http: reqwest::Client::new(),
    };
    let client = Client::new().unwrap();

    // 1 retries a 429 and sends the retry count
    mock.reset().await;
    let w = client.workspace().get(None).await.unwrap();
    assert_eq!(w.name, "Papaya");
    let seen = mock.log().await;
    let counts: Vec<_> = seen
        .iter()
        .map(|r| header(r, "x-frontmost-retry-count"))
        .collect();
    assert_eq!(counts, [Some("0"), Some("1")]);
    for r in &seen {
        assert_eq!(header(r, "authorization"), Some("Bearer fmk_test"));
        assert_eq!(header(r, "x-frontmost-lang"), Some("rust"));
        assert!(header(r, "x-frontmost-package-version").is_some_and(|v| !v.is_empty()));
    }

    // 2 reads every page in order
    mock.reset().await;
    let all = client
        .questions()
        .list("1", None, None)
        .collect_all()
        .await
        .unwrap();
    let ids: Vec<_> = all.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(ids, ["1", "2", "3"]);
    assert!(mock.log().await[1]["query"]
        .as_str()
        .unwrap()
        .contains("cursor=p2"));

    // 3 stops after 2 retries of a 500
    mock.reset().await;
    let e = client.projects().get("2", None).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::InternalServer);
    assert_eq!(e.code.as_deref(), Some("internal_error"));
    assert_eq!(e.request_id.as_deref(), Some("req_500"));
    assert_eq!(mock.log().await.len(), 3);

    // 4 never retries a 404 and keeps the API message
    mock.reset().await;
    let e = client.projects().get("3", None).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::NotFound);
    assert_eq!(e.status, Some(404));
    assert_eq!(e.code.as_deref(), Some("not_found"));
    assert_eq!(e.request_id.as_deref(), Some("req_404"));
    assert_eq!(
        e.message,
        "No project with this ID in this workspace. List projects at /api/v1/projects."
    );
    assert_eq!(mock.log().await.len(), 1);

    // 5 sends one Idempotency-Key on both attempts
    mock.reset().await;
    let body = QuestionsCreateBody {
        questions: vec![QuestionsCreateBodyQuestion {
            text: "Which bank is best for students?".into(),
            ..Default::default()
        }],
    };
    let out = client.questions().create("1", body, None).await.unwrap();
    assert_eq!(out.data[0].text, "Which bank is best for students?");
    let seen = mock.log().await;
    let keys: Vec<_> = seen.iter().map(|r| header(r, "idempotency-key")).collect();
    assert_eq!(keys.len(), 2);
    assert!(keys[0].is_some() && keys[0] == keys[1]);

    // 6 returns nothing for a 204
    mock.reset().await;
    // The `()` pattern fails to compile unless delete returns unit, and unwrap fails on a parse error.
    let () = client.profiles().delete("4", None).await.unwrap();

    // 7 never retries a 401
    mock.reset().await;
    let wrong = Client::with_options(ClientOptions {
        api_key: Some("fmk_wrong".into()),
        ..Default::default()
    })
    .unwrap();
    let e = wrong.workspace().get(None).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Authentication);
    assert_eq!(e.code.as_deref(), Some("invalid_key"));
    assert_eq!(mock.log().await.len(), 1);

    // 8 retries a 409 request_in_progress with the same key
    mock.reset().await;
    let body = ProfilesCreateBody {
        name: "Agency owner".into(),
        who: Some("Runs a small agency".into()),
    };
    let p = client.profiles().create("1", body, None).await.unwrap();
    assert_eq!(p.name, "Agency owner");
    let seen = mock.log().await;
    let keys: Vec<_> = seen.iter().map(|r| header(r, "idempotency-key")).collect();
    assert_eq!(keys.len(), 2);
    assert!(keys[0].is_some() && keys[0] == keys[1]);

    // 9 retries a timeout, then raises the timeout error
    mock.reset().await;
    let slow = Client::with_options(ClientOptions {
        timeout: Some(Duration::from_millis(100)),
        max_retries: Some(1),
        ..Default::default()
    })
    .unwrap();
    let e = slow.projects().get("6", None).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Timeout);
    assert_eq!(mock.log().await.len(), 2);

    // 10 raises the connection error when no server answers
    let none = Client::with_options(ClientOptions {
        base_url: Some("http://127.0.0.1:9/v1".into()),
        max_retries: Some(0),
        ..Default::default()
    })
    .unwrap();
    let e = none.workspace().get(None).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Connection);

    // 11 create_and_wait follows the 202 to the project
    mock.reset().await;
    let body = ProjectsCreateBody {
        domain: Some("papaya.example".into()),
        ..Default::default()
    };
    let p = client.projects().create_and_wait(body, None).await.unwrap();
    assert_eq!(p.id, "12");
    let seen = mock.log().await;
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1]["body"], serde_json::json!({ "setup_id": "12" }));
    let (first, second) = (
        header(&seen[0], "idempotency-key"),
        header(&seen[1], "idempotency-key"),
    );
    assert!(first.is_some() && second.is_some() && first != second);

    // 12 keeps the fields that an open reply does not name
    mock.reset().await;
    let scan = client.scans().get("12", "latest", None, None).await.unwrap();
    assert_eq!(scan.project.id, "12");
    assert_eq!(scan.extra["kpis"], serde_json::json!({ "visibility": 22 }));
}
