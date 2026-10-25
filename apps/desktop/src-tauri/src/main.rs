// A release build is a GUI program: no console window behind the app when it is launched.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    spm_desktop::run();
}
