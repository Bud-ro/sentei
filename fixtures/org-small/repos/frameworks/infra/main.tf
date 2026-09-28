resource "google_cloudfunctions2_function" "translate" {
  name = "translate"
  build_config {
    runtime     = "nodejs22"
    entry_point = "translateText"
  }
}
