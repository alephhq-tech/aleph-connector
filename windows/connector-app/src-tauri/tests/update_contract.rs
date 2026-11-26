#[path = "../src/update_package.rs"]
mod update_package;

use std::io::Write;

fn signed_fixture() -> (Vec<u8>, Vec<u8>) {
    let bytes = include_bytes!("fixtures/release-fixture.zip").to_vec();
    let signature = include_bytes!("fixtures/release-fixture.sig").to_vec();
    (bytes, signature)
}

#[test]
fn verifies_signed_release_and_rejects_tampering_relabel_and_downgrade() {
    let (bytes, signature) = signed_fixture();
    let key = include_bytes!("fixtures/test-public.der");
    let installer = update_package::verify_package(&bytes, &signature, key, "1.2.3", "1.2.2").unwrap();
    assert_eq!(installer, b"test installer bytes");
    assert!(update_package::verify_package(b"changed", &signature, key, "1.2.3", "1.2.2").is_err());
    assert!(update_package::verify_package(&bytes, &signature, key, "1.2.4", "1.2.2").is_err());
    assert!(update_package::verify_package(&bytes, &signature, key, "1.2.3", "1.2.3").is_err());
    assert!(update_package::verify_package(&bytes, &signature, key, "not-a-version", "1.2.2").is_err());
    let mut bad_sig = signature.clone();
    bad_sig[0] ^= 1;
    assert!(update_package::verify_package(&bytes, &bad_sig, key, "1.2.3", "1.2.2").is_err());
}

#[test]
fn accepts_signature_produced_by_dotnet_release_cli() {
    let bytes = include_bytes!("fixtures/release-fixture.zip");
    let signature = include_bytes!("fixtures/dotnet-signature.bin");
    let public_key = include_bytes!("fixtures/dotnet-public.der");
    assert_eq!(update_package::verify_package(bytes, signature, public_key, "1.2.3", "1.2.2").unwrap(), b"test installer bytes");
}

#[test]
fn rejects_unsafe_archive_entries() {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("version.txt", options).unwrap();
    writer.write_all(b"1.2.3").unwrap();
    writer.start_file("../installer.exe", options).unwrap();
    writer.write_all(b"malicious").unwrap();
    let zip = writer.finish().unwrap().into_inner();
    assert!(update_package::extract_verified_package(&zip, "1.2.3").is_err());
}
