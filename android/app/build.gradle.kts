plugins { id("com.android.application") }

android {
    namespace = "com.mercadoenluz.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.mercadoenluz.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    sourceSets.getByName("main").assets.srcDirs("../../app/web")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
