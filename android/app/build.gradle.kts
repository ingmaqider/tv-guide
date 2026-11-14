plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.ingmaqider.tvguide"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.ingmaqider.tvguide"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // "Scan QR code": Google Play services' scanner. Its UI runs in Play services, so the app
    // needs no camera permission.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
