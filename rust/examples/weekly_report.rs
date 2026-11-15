//! Print this week's numbers for one project, the rivals that AI apps name instead of you,
//! and the answers that cite reddit.com but do not name you.
//!
//!     FRONTMOST_API_KEY=fmk_... cargo run --example weekly_report -- 90

use frontmost_ai::{
    format_rate, AnswersListParams, Client, CompareTo, MetricsGetParams, Period, RivalsListParams,
};
use futures::StreamExt;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), frontmost_ai::Error> {
    let project_id = std::env::args().nth(1).unwrap_or_else(|| "90".into());
    let client = Client::new()?;

    let params = MetricsGetParams {
        period: Some(Period::Week),
        compare_to: Some(CompareTo::Previous),
        ..Default::default()
    };
    let metrics = client
        .metrics()
        .get(&project_id, Some(params), None)
        .await?;
    let Some(totals) = metrics.totals else {
        println!("{}", metrics.message.unwrap_or_default());
        return Ok(());
    };
    println!("Visibility  {}", format_rate(Some(&totals.visibility)));
    println!("Win rate    {}", format_rate(Some(&totals.win_rate)));

    let params = RivalsListParams {
        period: Some(Period::Week),
        ..Default::default()
    };
    let mut rivals = client
        .rivals()
        .list(&project_id, Some(params), None)
        .collect_all()
        .await?;
    rivals.sort_by_key(|rival| std::cmp::Reverse(rival.named_instead_of_you));
    for rival in rivals.iter().take(3) {
        println!(
            "{} was named instead of you in {} answers",
            rival.name, rival.named_instead_of_you
        );
    }

    let params = AnswersListParams {
        cited_domain: Some("reddit.com".into()),
        named: Some(false),
        limit: Some(5),
        ..Default::default()
    };
    let mut answers = Box::pin(
        client
            .answers()
            .list(&project_id, Some(params), None)
            .stream(),
    );
    while let Some(answer) = answers.next().await {
        let answer = answer?;
        println!("{}: {}", answer.app, answer.question.text);
    }
    Ok(())
}
