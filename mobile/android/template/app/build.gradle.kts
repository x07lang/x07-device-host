plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "org.x07.deviceapp"
  compileSdk = 34

  defaultConfig {
    applicationId = "__X07_ANDROID_APPLICATION_ID__"
    minSdk = __X07_ANDROID_MIN_SDK__
    targetSdk = 34
    versionCode = __X07_BUILD__
    versionName = "__X07_VERSION__"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.appcompat:appcompat:1.6.1")
  implementation("androidx.webkit:webkit:1.9.0")
}

