//! The NAS binary.

use std::net::SocketAddr;

/// The listen address for a `SPM_PORT` value; unset means 3000.
fn listen_addr(port: Option<&str>) -> Result<SocketAddr, String> {
    let port: u16 = match port {
        None => 3000,
        Some(raw) => raw
            .parse()
            .map_err(|_| format!("SPM_PORT is not a port: {raw}"))?,
    };
    Ok(SocketAddr::from(([0, 0, 0, 0], port)))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = listen_addr(std::env::var("SPM_PORT").ok().as_deref())?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, spm_http::router()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_validates_the_port() {
        assert_eq!(listen_addr(None).unwrap().port(), 3000);
        assert_eq!(listen_addr(Some("8080")).unwrap().port(), 8080);
        assert!(listen_addr(Some("nope")).is_err());
    }
}
