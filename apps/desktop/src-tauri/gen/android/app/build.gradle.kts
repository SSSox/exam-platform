import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// The release key is never in the repository: gen/android/keystore.properties (ignored by git) points to it.
// Passwords may stay out of that file too, in KEYSTORE_PASSWORD and KEY_PASSWORD. Without the file the release APK stays unsigned.
// A missing value fails only the release packaging (see the end of this file), so debug builds and Android Studio sync keep working.
val keystoreFile: java.io.File = rootProject.file("keystore.properties")
val keystoreProperties: Properties = Properties().apply {
    if (keystoreFile.exists()) {
        // UTF-8, so a key path with Cyrillic letters is read as written; a BOM left by Notepad is dropped.
        load(keystoreFile.readText(Charsets.UTF_8).removePrefix("\uFEFF").reader())
    }
}
// Paths and aliases are trimmed (a trailing space is invisible in the file); passwords are taken as written.
fun keystoreValue(name: String, env: String, trim: Boolean): String? {
    val clean = { v: String? -> (if (trim) v?.trim() else v)?.takeIf { it.isNotEmpty() } }
    return clean(keystoreProperties.getProperty(name)) ?: clean(System.getenv(env))
}
val keystoreValues: Map<String, String?> = if (!keystoreFile.exists()) emptyMap() else mapOf(
    "storeFile" to keystoreValue("storeFile", "KEYSTORE_FILE", true),
    "storePassword" to keystoreValue("storePassword", "KEYSTORE_PASSWORD", false),
    "keyAlias" to keystoreValue("keyAlias", "KEY_ALIAS", true),
    "keyPassword" to keystoreValue("keyPassword", "KEY_PASSWORD", false),
)
val keystoreMissing: List<String> = keystoreValues.filterValues { it == null }.keys.toList()

// The address of the update manifest, shared with the desktop app: plugins.updater.endpoints[0] in tauri.conf.json.
// AppUpdates.kt accepts only a GitHub "releases/latest/download" address; anything else (or none) turns updates off.
val updateManifest: String = run {
    val config = groovy.json.JsonSlurper().parse(rootProject.file("../../tauri.conf.json")) as Map<*, *>
    val updater = (config["plugins"] as? Map<*, *>)?.get("updater") as? Map<*, *>
    val url = (updater?.get("endpoints") as? List<*>)?.firstOrNull() as? String ?: ""
    if (Regex("""^https://[A-Za-z0-9./_-]+$""").matches(url)) url else ""
}

android {
    compileSdk = 37
    signingConfigs {
        if (keystoreValues.isNotEmpty() && keystoreMissing.isEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreValues.getValue("storeFile")!!)
                storePassword = keystoreValues.getValue("storePassword")
                keyAlias = keystoreValues.getValue("keyAlias")
                keyPassword = keystoreValues.getValue("keyPassword")
            }
        }
    }
    namespace = "kz.examtrainer.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "kz.examtrainer.app"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("String", "UPDATE_MANIFEST", "\"$updateManifest\"")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

// keystore.properties is there but incomplete: packaging a release APK or bundle stops instead of producing one no phone installs.
// Compiling, lint and tests of the release variant still run, and so does Android Studio's own signing wizard.
val injectedSigning: Boolean = providers.gradleProperty("android.injected.signing.store.file").isPresent
if (keystoreMissing.isNotEmpty() && !injectedSigning) {
    val message = "keystore.properties: no value for ${keystoreMissing.joinToString()}. Fill it in the file (saved as UTF-8) " +
        "or set KEYSTORE_FILE, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD."
    tasks.matching { (it.name.startsWith("package") && (it.name.endsWith("Release") || it.name.endsWith("ReleaseUniversalApk"))) || (it.name.startsWith("sign") && it.name.endsWith("ReleaseBundle")) }
        .configureEach { doFirst { throw GradleException(message) } }
}

apply(from = file("tauri.build.gradle.kts"))
