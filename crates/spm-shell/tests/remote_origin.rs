//! "The connect form and `parseRemoteOrigin` refuse the same addresses" (Electron
//! `remote.test.ts`), with the table shared with the web app's `core/desktop.test.ts` so the two
//! cannot drift. The web's `isServerAddress` is a UX check; this is the one that decides.

use std::path::Path;

use serde_json::Value;
use spm_core::validate::server_url;
use spm_shell::remote::parse_remote_origin;

fn table() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/web/src/core/server-addresses.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn list(table: &Value, key: &str) -> Vec<String> {
    table[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_shell_accepts_every_address_the_connect_form_accepts_and_refuses_every_one_it_refuses() {
    let table = table();
    let accepted = list(&table, "accepted");
    let refused = list(&table, "refused");
    assert!(accepted.len() >= 5 && refused.len() >= 10);
    for address in accepted {
        assert!(
            parse_remote_origin(&address).is_ok(),
            "{address:?} is accepted by the form and refused by the shell"
        );
    }
    for address in refused {
        assert!(
            parse_remote_origin(&address).is_err(),
            "{address:?} is refused by the form and accepted by the shell"
        );
    }
}

#[test]
fn core_validation_and_the_shell_agree_on_what_is_an_origin() {
    // `spm_core::validate::server_url` is the library-side rule for the same thing (the form of a
    // server address in a request body, should one ever carry one). Where it has an opinion, so
    // does the shell. (Core does not trim, so only addresses without surrounding space compare.)
    let table = table();
    for key in ["accepted", "refused"] {
        for address in list(&table, key) {
            if address.trim() != address || address.trim().is_empty() {
                continue;
            }
            // The shell additionally refuses what the URL parser normalised away (`/api/../..`),
            // which core, working from the parsed URL, cannot see; that is the stricter side.
            let core = server_url(&address).is_ok();
            let shell = parse_remote_origin(&address).is_ok();
            assert!(
                !shell || core,
                "{address:?}: the shell accepts what core refuses"
            );
        }
    }
}
