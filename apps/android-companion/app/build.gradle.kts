plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val configuredApiBase = (project.findProperty("apiBaseUrl") as String?) ?: "http://10.0.2.2:8000/api/v1/"

android {
    namespace = "com.businessassistant.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.businessassistant.phone"
        minSdk = 29
        targetSdk = 35
        versionCode = 6
        versionName = "0.5.0"
        buildConfigField("String", "API_BASE_URL", "\"$configuredApiBase\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        debug { manifestPlaceholders["allowCleartext"] = "true" }
        release {
            isMinifyEnabled = false
            manifestPlaceholders["allowCleartext"] = "false"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
}
