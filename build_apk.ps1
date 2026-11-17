$ErrorActionPreference = "Stop"

$BUILD_TOOLS = "C:\Users\VARDHAN\AppData\Local\Android\Sdk\build-tools\34.0.0"
$ANDROID_JAR = "C:\Users\VARDHAN\AppData\Local\Android\Sdk\platforms\android-35\android.jar"
$JDK_BIN = "C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot\bin"

Write-Host ">>> Step 1: Compiling Android Resources with aapt2..."
& "$BUILD_TOOLS\aapt2.exe" compile --dir "android\res" -o "android\compiled_res.zip"

Write-Host ">>> Step 2: Linking Resources & Packaging Assets into base.apk..."
& "$BUILD_TOOLS\aapt2.exe" link -I $ANDROID_JAR "android\compiled_res.zip" --manifest "android\AndroidManifest.xml" -o "android\base.apk" -A "android\assets" --java "android\gen" --auto-add-overlay

Write-Host ">>> Step 3: Compiling Java Sources with javac..."
& "$JDK_BIN\javac.exe" -source 8 -target 8 -cp "$ANDROID_JAR;android\gen" "android\src\com\rapidaid\app\MainActivity.java" "android\gen\com\rapidaid\app\R.java" -d "android\bin"

Write-Host ">>> Step 4: Compiling to Dalvik Executable (classes.dex) with d8..."
$classFiles = Get-ChildItem "android\bin\com\rapidaid\app\*.class" | ForEach-Object { $_.FullName }
& "$BUILD_TOOLS\d8.bat" $classFiles --output "android" --lib $ANDROID_JAR --min-api 24

Write-Host ">>> Step 5: Adding classes.dex to base.apk..."
& "$JDK_BIN\jar.exe" uf "android\base.apk" -C "android" "classes.dex"

Write-Host ">>> Step 6: Aligning APK with zipalign..."
if (Test-Path "android\RapidAid-aligned.apk") { Remove-Item "android\RapidAid-aligned.apk" -Force }
& "$BUILD_TOOLS\zipalign.exe" -v -p 4 "android\base.apk" "android\RapidAid-aligned.apk"

Write-Host ">>> Step 7: Generating Debug Keystore if missing..."
if (-not (Test-Path "android\debug.keystore")) {
    & "$JDK_BIN\keytool.exe" -genkey -v -keystore "android\debug.keystore" -alias "androiddebugkey" -keyalg RSA -keysize 2048 -validity 10000 -storepass "android" -keypass "android" -dname "CN=Android Debug,O=Android,C=US"
}

Write-Host ">>> Step 8: Signing APK with apksigner..."
if (Test-Path "RapidAid.apk") { Remove-Item "RapidAid.apk" -Force }
& "$BUILD_TOOLS\apksigner.bat" sign --ks "android\debug.keystore" --ks-pass "pass:android" --key-pass "pass:android" --out "RapidAid.apk" "android\RapidAid-aligned.apk"

Write-Host ">>> SUCCESS: RapidAid.apk generated successfully!"
Get-Item "RapidAid.apk" | Select-Object Name, Length, LastWriteTime

