//! Jade Vault's logic in Rust, shared by the Android app (native, on every core) and the browser build
//! (WebAssembly). No I/O here: the hosts read files, keep time and talk to the network.

pub mod html;
pub mod sentry;
pub mod vault;
