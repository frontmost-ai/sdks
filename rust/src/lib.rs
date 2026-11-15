//! Client for the Frontmost AI API.
//!
//! ```no_run
//! # async fn run() -> Result<(), frontmost_ai::Error> {
//! let client = frontmost_ai::Client::new()?; // reads FRONTMOST_API_KEY
//! let questions = client.questions().list("1", None, None).collect_all().await?;
//! # Ok(()) }
//! ```

mod core;
mod generated;

pub use crate::core::{
    format_rate, Client, ClientOptions, Error, ErrorKind, ListPage, Page, RequestOptions, VERSION,
};
pub use generated::*;
