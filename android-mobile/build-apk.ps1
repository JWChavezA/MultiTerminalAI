$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root "build"
$Sdk = "C:\Program Files (x86)\Android\android-sdk"
$Jdk = "C:\Program Files\Android\openjdk\jdk-21.0.8"
$BuildTools = Join-Path $Sdk "build-tools\36.0.0"
$Platform = Join-Path $Sdk "platforms\android-35\android.jar"
$Package = "com.local.multiterminalai"
$Unsigned = Join-Path $Out "MTAI-Remote-unsigned.apk"
$Aligned = Join-Path $Out "MTAI-Remote-aligned.apk"
$Final = Join-Path $Out "MTAI-Remote.apk"
$Keystore = Join-Path $Out "debug.keystore"

Remove-Item -LiteralPath $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Out, (Join-Path $Out "classes"), (Join-Path $Out "compiled"), (Join-Path $Out "dex") | Out-Null
$env:JAVA_HOME = $Jdk
$env:PATH = "$Jdk\bin;$env:PATH"

& (Join-Path $BuildTools "aapt2.exe") compile --dir (Join-Path $Root "res") -o (Join-Path $Out "compiled\res.zip")
& (Join-Path $BuildTools "aapt2.exe") link -o $Unsigned -I $Platform --manifest (Join-Path $Root "AndroidManifest.xml") (Join-Path $Out "compiled\res.zip") --java (Join-Path $Out "generated") --auto-add-overlay

$Sources = @(
  (Join-Path $Root "src\com\local\multiterminalai\MainActivity.java"),
  (Join-Path $Out "generated\com\local\multiterminalai\R.java")
)
& (Join-Path $Jdk "bin\javac.exe") -source 8 -target 8 -classpath $Platform -d (Join-Path $Out "classes") $Sources
$ClassFiles = Get-ChildItem -LiteralPath (Join-Path $Out "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& (Join-Path $BuildTools "d8.bat") --lib $Platform --output (Join-Path $Out "dex") $ClassFiles

Copy-Item -LiteralPath $Unsigned -Destination (Join-Path $Out "with-dex.apk") -Force
& (Join-Path $Jdk "bin\jar.exe") uf (Join-Path $Out "with-dex.apk") -C (Join-Path $Out "dex") classes.dex
Move-Item -LiteralPath (Join-Path $Out "with-dex.apk") -Destination $Unsigned -Force

& (Join-Path $BuildTools "zipalign.exe") -f 4 $Unsigned $Aligned

if (-not (Test-Path -LiteralPath $Keystore)) {
  & (Join-Path $Jdk "bin\keytool.exe") -genkeypair -v -keystore $Keystore -storepass android -alias mtai -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=MultiTerminalAI Remote,O=Local,C=US"
}

& (Join-Path $BuildTools "apksigner.bat") sign --ks $Keystore --ks-pass pass:android --key-pass pass:android --out $Final $Aligned
& (Join-Path $BuildTools "apksigner.bat") verify --verbose $Final

Write-Host "APK listo: $Final"
