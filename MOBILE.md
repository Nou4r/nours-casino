# Shipping Nour's Casino as a phone app

Written for someone who has never built a mobile app, on **Windows 10**, with
Node 25.9.0, npm 11.12.1 and git already installed, and **no JDK, no Android SDK
and no Mac**. Every command is copy-pasteable. Windows commands are for
**Command Prompt or PowerShell**; where a command is macOS-only it is labelled.

The web app itself does not change. `python -m http.server 8080` →
`http://localhost:8080/index.html` keeps working exactly as before, with or
without any of this installed.

---

## 1. What Capacitor actually is

Capacitor generates a **real native app project** — a Gradle/Android Studio
project under `android/`, an Xcode project under `ios/` — whose single screen is
a full-bleed system WebView loading this app's HTML, CSS and JS from inside the
app bundle. It also ships a JS↔native bridge, so JavaScript can call real
platform APIs (vibration, status bar, hardware back button) through
`window.Capacitor.Plugins`. The output is an `.apk`/`.aab`/`.ipa` — a genuine
store binary.

It is **not** a browser bookmark, **not** a PWA or "Add to Home Screen"
shortcut, and **not** a rewrite: no framework, no bundler, no port. The same
`index.html` and `js/**` run in the phone app and in Chrome on your desktop.

---

## 2. One-time setup (Android, on Windows)

You only ever do this once per machine.

### 2.0 You can skip most of this until you actually need to compile

Worth knowing before you download a gigabyte of tooling: **none of it is needed
to create the native projects.** Verified on this machine with `java`, `javac`,
`gradle` and `adb` all absent from `PATH` and `JAVA_HOME` / `ANDROID_HOME` both
unset, these all completed successfully:

```bat
npm install
npm run build
npx cap add android
npx cap add ios
npx cap sync
```

The Capacitor CLI is plain Node. The JDK and the Android SDK are needed only to
**compile** an APK or AAB (§4, §5); Xcode is needed only to compile and sign the
iOS app (§7). So you can get all the way to a real, complete native project —
and inspect it — before installing anything below. Install §2.1–2.5 when you
want an app on a phone.

### 2.1 Install JDK 21 (Temurin)

Gradle needs a Java Development Kit. Android Gradle Plugin 8.x wants JDK 17 or
21; use 21.

1. Download the **Windows x64 JDK 21 `.msi`** from
   <https://adoptium.net/temurin/releases/?version=21&os=windows&arch=x64&package=jdk>
2. Run the installer. On the "Custom Setup" screen, enable **"Set JAVA_HOME
   variable"** — this saves you a step. Leave everything else at defaults.

It installs to something like
`C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot`. Note the exact folder
name; the version digits change with every release.

### 2.2 Install Android Studio

Android Studio is how you get the Android SDK, the emulator and a device
manager. You will not write any Java or Kotlin.

1. Download from <https://developer.android.com/studio> and run the installer
   (accept the defaults).
2. Launch it. The first-run wizard downloads the SDK — pick **Standard**, accept
   the licences, let it finish. It installs to
   `C:\Users\<you>\AppData\Local\Android\Sdk`.

### 2.3 Add the SDK components you need

In Android Studio: **More Actions ▾ → SDK Manager** (or **Settings → Languages &
Frameworks → Android SDK**).

On the **SDK Platforms** tab, tick the box for:

- **Android 15.0 (API 35)** — and **Android 16.0 (API 36)** as well; they are a
  few hundred MB each and it costs nothing to have both.

On the **SDK Tools** tab, tick **Show Package Details** and make sure you have:

- **Android SDK Build-Tools** — the newest 35.x and 36.x entries
- **Android SDK Platform-Tools** — this is what gives you `adb`
- **Android SDK Command-line Tools (latest)**
- **Android Emulator**
- **Google USB Driver** — Windows-only, needed to talk to a physical phone

Click **Apply** and let it download.

> Which platform you *actually* need is whatever `compileSdkVersion` says in
> `android/variables.gradle` after you first run `npx cap add android`. Open that
> file and check; installing both 35 and 36 up front means you will not have to
> come back here.

### 2.4 Set `JAVA_HOME` and `ANDROID_HOME`

Open **Command Prompt** and run these two, substituting your real JDK folder
name from step 2.1:

```bat
setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot"
setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
```

`setx` writes the variable permanently for your user account. It does **not**
affect the window you typed it in — close that window and open a new one.

Now put `adb` on your `PATH`. **Do not use `setx PATH ...`**: `setx` truncates
values at 1024 characters and flattens your system and user PATH together. That
combination silently mangles your PATH, and it is one of the most common ways to
break a Windows dev machine. Use PowerShell, which edits
only the user-scoped PATH:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$old = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', "$old;$sdk\platform-tools;$sdk\emulator", 'User')
```

(Equivalent GUI route, if you prefer: press <kbd>Win</kbd>+<kbd>R</kbd>, run
`sysdm.cpl`, **Advanced → Environment Variables**, edit **Path** under "User
variables", **New**, paste
`C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools`.)

### 2.5 Verify

**Close every terminal and open a fresh one**, then:

```bat
java -version
adb --version
echo %JAVA_HOME%
echo %ANDROID_HOME%
```

You want roughly:

```
openjdk version "21.0.5" 2024-10-15 LTS
Android Debug Bridge version 1.0.41
C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot
C:\Users\<you>\AppData\Local\Android\Sdk
```

If `java` or `adb` is "not recognized", you are in a stale terminal — open a new
one. If it still fails, the PATH edit did not land; redo 2.4.

### 2.6 Install this project's dependencies

Once, in the repo root:

```bat
npm install
npx cap add android
```

`npm install` fetches the Capacitor CLI and plugins into `node_modules/`.
`npx cap add android` generates the `android/` native project. Both are one-time.

---

## 3. The daily loop

You edit `index.html`, `styles.css`, `css/**` and `js/**` in the repo root, as
always. Nothing about that changes.

### 3.1 Two commands

```bat
npm run sync
npm run android
```

- **`npm run sync`** runs `node scripts/build-www.mjs` (which copies
  `index.html`, `styles.css`, `css/**`, `js/**` and `fonts/**` into a clean
  `www/`) and then `cap sync` (which copies `www/` into `android/` and `ios/`
  and re-registers plugins). Run it after **every** web change.
- **`npm run android`** does the sync and then opens the project in Android
  Studio. Press the green **▶ Run** button there to install and launch.

`www/` is **generated output**. Never edit it — see §10.

Before committing, run the project's gate:

```bat
npm run check
```

It `node --check`s every file under `js/**` and audits `capacitor.config.js`.
A three-second habit that catches the two failures that are hardest to diagnose
later: a syntax error that only shows up as a white screen on a phone (§10), and
a config that silently resolves to nothing (§6).

### 3.2 Running on your own phone (USB)

1. **Enable Developer Options.** On the phone: **Settings → About phone**, find
   **Build number**, and tap it **seven times**. You will get a "You are now a
   developer!" toast. (On Samsung it is **Settings → About phone → Software
   information → Build number**.)
2. **Settings → System → Developer options → USB debugging** → on.
3. Plug the phone into the PC with a USB cable that carries data (many charging
   cables do not). Pull down the notification shade, tap the USB notification,
   and choose **File transfer / Android Auto** rather than "Charging only".
4. On the PC:

   ```bat
   adb devices
   ```

   The phone shows a **"Allow USB debugging?"** dialog — tick *Always allow* and
   accept. Re-run `adb devices`; you should see a serial number followed by
   `device`. If it says `unauthorized`, you missed the dialog. If the list is
   empty, install the **Google USB Driver** (§2.3) or the manufacturer's own
   Windows driver.
5. Your phone now appears in the device dropdown in Android Studio. Hit ▶.

### 3.3 Running on an emulator

In Android Studio: **More Actions ▾ → Virtual Device Manager → Create Device**.
Pick **Pixel 7** (or any phone), **Next**, choose a system image — take an
**API 35** one with Google Play, click the ⬇ to download it — **Next**,
**Finish**. It then appears in the same device dropdown as a physical phone.

#### The emulator needs a hypervisor — this is not optional

VT-x being enabled in your BIOS is **necessary but not sufficient**. Windows
also needs a hypervisor layer on top, and without one the emulator starts,
attaches to `adb` as `offline`, and then simply never boots — no error, no
crash, no timeout. It just sits there forever.

This was tested here, and it is why the shipped APK has never been launched:

```
> emulator -accel-check
  Android Emulator hypervisor driver is not installed on this machine
```

Two images were tried with `-accel off` (pure software CPU emulation):
`android-36 google_apis x86_64` for 10 minutes, and the much lighter
`android-28 default x86` for 12 minutes. **Both stayed `offline` and never
reached `sys.boot_completed`.** Software emulation of a full Android boot is
not viable on a 4-core i3 — do not waste time on `-accel off`.

**The fix**, in an **Administrator** PowerShell — needs a reboot:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All
```

Reboot, then confirm it took:

```bat
.toolchain\android-sdk\emulator\emulator.exe -accel-check
```

You want it to report accelerator available rather than the message above.
Then boot the AVD that already exists:

```bat
.toolchain\android-sdk\emulator\emulator.exe -avd nc28
.toolchain\android-sdk\platform-tools\adb.exe install -r NoursCasino-debug.apk
.toolchain\android-sdk\platform-tools\adb.exe shell am start -n com.nourscasino.app/.MainActivity
```

If you would rather not enable Hyper-V (it can conflict with VirtualBox and
some anti-cheat), **use a real phone instead — §3.2**. That is the faster path
and it is what the APK was built for.

#### Checking for a white screen

`am start` reports success even when the page is blank, so read the WebView
console rather than trusting the exit code:

```bat
.toolchain\android-sdk\platform-tools\adb.exe logcat -s chromium:* Capacitor:* AndroidRuntime:*
```

A failed ES-module fetch or a wrong WebView origin shows up there and nowhere
else. You can also open `chrome://inspect` in desktop Chrome with the phone
plugged in and get full DevTools against the running app.

### 3.4 Live reload — iterating without rebuilding

A full Gradle build takes 30–90 seconds. For CSS and JS tweaking that is
miserable. Instead:

```bat
npx cap run android --livereload --external
```

This starts a small web server on your PC, points the phone's WebView at
`http://<your-PC-LAN-IP>:<port>` instead of the bundled copy, and reloads the
page when files change. No rebuild per edit.

Three caveats, all of which will bite you if you do not know them:

- **The phone must be on the same network as the PC.** `--external` binds the
  dev server to your LAN IP rather than `localhost`. Same Wi-Fi, and your PC's
  Wi-Fi profile must be **Private**, not Public. Windows Defender Firewall will
  pop a prompt the first time — allow Node.js on **private networks**.
- **It serves `www/`, not the repo root.** Live reload skips the *native*
  rebuild, not the copy step. Run `npm run build` after editing root files, or
  edit and re-run `npm run sync` in a second terminal.
- **Your wallet will look empty.** In live-reload mode the WebView's origin is
  `http://192.168.x.x:port`, not `https://localhost`, and `localStorage` is
  partitioned by origin (§6). So you get a fresh 1000-credit balance and no
  profiles. This is harmless and temporary — the real store is untouched and
  comes back the moment you go back to a normal `npm run android`.

---

## 4. Building an installable APK

> **An APK already exists in this repo: `NoursCasino-debug.apk` (6.4 MB).**
> It was built here on Windows with `assembleDebug`, is debug-signed and
> therefore installable, and contains package `com.nourscasino.app`, label
> "Nour's Casino", `versionName 1.0`, `minSdk 24`, `targetSdk 36`.
> **It has never been launched** — there is no emulator or phone on this
> machine, so "compiles and is signed" is all that has been proven. Installing
> it (below) is the first real test.
>
> It is gitignored, and rebuilding it overwrites nothing you care about.

An APK is a single file you can install directly on a phone. This is what you
send to a friend to try; it is *not* what you upload to Google Play (§5).

**Windows:**

```bat
cd android
gradlew.bat assembleDebug
```

**macOS / Linux:**

```bash
cd android
./gradlew assembleDebug
```

The first run downloads Gradle itself and takes several minutes. Afterwards it
is under a minute.

#### If you have no JDK or Android Studio, and want the APK anyway

You do not need the 1 GB Android Studio install to compile. This repo's APK was
produced with a **self-contained toolchain in `.toolchain/`** (gitignored),
which touches no system setting and no `PATH` — delete the folder and it is as
if it never happened. To reproduce it:

1. Download the two archives:
   - Temurin JDK 21 (Windows x64 **`.zip`**, not the installer) —
     <https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse>
   - Android command-line tools —
     <https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip>
2. Unzip both into `.toolchain\`. Then move the extracted `cmdline-tools`
   folder so it sits at **`.toolchain\android-sdk\cmdline-tools\latest\`**.
   That exact nesting is mandatory: unzipped anywhere else, `sdkmanager` fails
   with "Could not determine SDK root".
3. Install the SDK pieces. `--licenses` is interactive and will hang a script,
   so pipe it:

```bat
set JAVA_HOME=%CD%\.toolchain\jdk-21.0.11+10
set ANDROID_HOME=%CD%\.toolchain\android-sdk
.toolchain\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat --sdk_root=%ANDROID_HOME% "platform-tools" "platforms;android-36" "build-tools;36.0.0"
.toolchain\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat --sdk_root=%ANDROID_HOME% --licenses
```

4. Point Gradle at it. Create **`android\local.properties`** — Gradle does not
   reliably pick up `ANDROID_HOME`, and this file is a `java.util.Properties`
   file where `\` is an escape character, so use forward slashes:

```
sdk.dir=C:/Users/<you>/Desktop/NoursCasino/.toolchain/android-sdk
```

5. Build. `android-36`, `build-tools;36.0.0` and JDK 21 are what this project
   pins (`android/variables.gradle`, AGP 8.13.0, Gradle 8.14.3) — older
   versions will fail.

Total download is roughly 1.5 GB including Gradle's own distribution, and the
first build took **2m 07s** here.

The file lands at:

```
android\app\build\outputs\apk\debug\app-debug.apk
```

### Sideloading it

Easiest, with the phone plugged in and USB debugging on (§3.2) — from the repo
root:

```bat
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

`-r` reinstalls over an existing copy, keeping its data.

Without a cable: copy the `.apk` to the phone (email it to yourself, Google
Drive, USB file transfer), tap it in the phone's Files app, and grant that app
**"Install unknown apps"** when Android asks. Android will warn you the app came
from an unknown source; that is expected for a debug build.

A debug APK is signed with an automatically generated throwaway debug key. It
installs fine and it can never be published.

---

## 5. Signing for release

Google Play will not accept an unsigned or debug-signed upload. You need your
own keystore.

### 5.1 Generate the keystore

`keytool` ships with the JDK. From the repo root:

```bat
"%JAVA_HOME%\bin\keytool" -genkeypair -v -keystore nours-casino-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias nours-casino
```

It asks for a keystore password, then your name/organisation/city/country (any
honest answer is fine; this appears in the certificate, not in the store
listing), then a key password — press Enter to reuse the keystore password.

`-validity 10000` is ~27 years. Google Play requires a certificate valid until
at least 22 October 2033, so do not shorten it.

**Move `nours-casino-release.jks` somewhere outside the repo** — e.g.
`C:\keys\` — and back it up somewhere you will still have in five years. Then
read §6 before you do anything else.

### 5.2 `android/key.properties`

Create `android/key.properties`:

```properties
storePassword=your-keystore-password
keyPassword=your-key-password
keyAlias=nours-casino
storeFile=C:/keys/nours-casino-release.jks
```

**Use forward slashes** even on Windows. `.properties` files treat `\` as an
escape character, so `C:\keys\...` silently becomes garbage.

Add both of these to `.gitignore` — passwords and private keys never go in git:

```gitignore
android/key.properties
*.jks
*.keystore
```

### 5.3 The `signingConfigs` block

Open `android/app/build.gradle`. At the **very top of the file**, above
`apply plugin:` / the `android {` block, add:

```gradle
def keystorePropertiesFile = rootProject.file('key.properties')
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
```

Then **inside** the existing `android { ... }` block, add a `signingConfigs`
block and point the existing `release` build type at it:

```gradle
android {
    // ...whatever Capacitor already generated stays here...

    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
```

`rootProject` here is the `android/` folder, so `rootProject.file('key.properties')`
resolves to `android/key.properties`. The `if (exists)` guard is what lets the
CI workflow in `.github/workflows/android.yml` build a debug APK on a machine
that has no keystore at all.

### 5.4 Build the `.aab`

Google Play takes an **Android App Bundle** (`.aab`), not an APK.

```bat
cd android
gradlew.bat bundleRelease
```

Output:

```
android\app\build\outputs\bundle\release\app-release.aab
```

That is the file you upload to Play Console.

### 5.5 Losing the keystore

> ### ⚠️ LOSE THE KEYSTORE AND YOU CAN NEVER UPDATE THE APP AGAIN.
>
> Android identifies an app by *package name + signing certificate*. An APK or
> AAB signed with a different key is, as far as every Android device is
> concerned, a completely different app. It cannot update the installed one; it
> can only be installed alongside it under a new listing, with zero users.
>
> There is no recovery, no support ticket, no "prove you own it" flow for a
> self-managed signing key. Back up the `.jks` and its passwords in at least two
> places (a password manager and an offline copy), today.

One narrowing of that, stated precisely so you do not rely on it by accident:
if you enrol in **Play App Signing** (the default for new apps on Play), Google
holds the real *app signing* key and your `.jks` is only the *upload* key — and
a lost upload key **can** be reset through Play Console support. That safety net
covers Play distribution only. It does nothing for an app you sideload or ship
outside Play, and it does not exist until you have actually enrolled. Treat the
keystore as irreplaceable regardless.
[VERIFY] upload-key reset procedure:
<https://support.google.com/googleplay/android-developer/answer/9842756>

---

## 6. Two things you can never undo

§5.5 is the first. This is the second, and it is easier to trigger by accident,
because it looks like a one-word config tidy-up.

### The wallet lives in origin-scoped `localStorage`

Everything a player owns is in the browser's `localStorage`, under two keys:

| Key | Contents |
|---|---|
| `plinko.session.v1` | balance, current bet, provably-fair seed pair, nonce, round history, lifetime stats, Plinko bucket counts |
| `plinko.accounts.v1` | every named player profile, each with its own full session snapshot |

`localStorage` is partitioned **by origin**. Not by app, not by package name —
by scheme + host + port. Capacitor builds that origin out of exactly three
config keys: `server.androidScheme`, `server.iosScheme` and `server.hostname`.
With this project's values that is `https://localhost` on Android and
`capacitor://localhost` on iOS.

### Change any of those three after launch and every player is wiped

Edit `hostname` from `localhost` to `app`, or `androidScheme` from `https` to
`http`, ship the update, and on next launch the WebView loads a **different
origin**. The old `localStorage` is not migrated, not merged, and not deleted —
it is *orphaned*, sitting there under an origin nothing reads any more. The app
boots to a pristine 1000-credit balance, no profiles, fresh seeds.

There is no error. No crash. No console trace. No migration path. Nothing in the
logs. To the player it looks exactly like "the app reset itself", and support
has nothing to look at.

### The rule

**`server.androidScheme`, `server.iosScheme` and `server.hostname` are immutable
after the first public release — exactly as immutable as the signing keystore.**

In this repo they are pinned in **`capacitor.config.js`**. It is a `.js` config
rather than `.json` for one reason: JSON cannot carry a comment, and the warning
is the most important thing in that file. What is actually shipped there:

```js
export const server = {
  androidScheme: 'https',
  iosScheme: 'capacitor',
  hostname: 'localhost',
};
```

They are written out explicitly rather than left to Capacitor's defaults so the
origin is frozen in the repo instead of floating with whatever a future
Capacitor release decides its defaults should be — and so that any change is an
obvious, deliberate act in a diff rather than silent drift. These three values
*are* the current defaults, so pinning them changes nothing today and guarantees
everything tomorrow. A large block comment directly above that `server` block is
the other half of this warning; read it before you touch the file.

### The config file uses named exports on purpose. Do not "fix" it.

Notice that shape: `export const server = …`, not the `export default { … }`
that every Capacitor tutorial and doc page shows. That is deliberate, it is
verified against the CLI, and converting it back is a third way to lose the
origin — so it belongs in this section.

`@capacitor/cli@8.4.2` loads a `.js` config with, verbatim, from
`node_modules/@capacitor/cli/dist/config.js` (`loadExtConfigJS`):

```js
extConfig: await require(extConfigFilePath),
```

There is no `.default` unwrap. The `.ts` loader a few functions above *does*
have one; the `.js` loader does not. Because `package.json` is
`"type": "module"`, that `require()` hands back the ES module namespace — so
`export default {…}` arrives as `{ __esModule: true, default: {…} }` and **every
key is invisible to the CLI**. It does not warn and it does not fail. `appId`
and `appName` come back as empty strings, and the app quietly builds on
Capacitor's own defaults — including a different `localStorage` origin, which is
precisely the catastrophe this whole section is about.

Top-level named exports land flat on that namespace, which is exactly the object
the CLI wants. `npm run check` guards it: it loads the config the way the CLI
does and asserts `appId`, `appName`, `webDir` and the three origin keys, exiting
non-zero with a targeted message if someone converts the file to
`export default`. Run it before you commit any config change.

> If a later change ever makes it impossible to keep those values, the migration
> is a code change, not a config change: ship a release that, on the *old*
> origin, exports both keys somewhere origin-independent (a Capacitor
> `Preferences`/native store, or a file), *then* a second release that moves the
> origin and imports. Two releases, in that order. Flipping the config alone is
> data loss.

---

## 7. iOS without a Mac

Two facts first, because they decide everything else.

### 7.1 `npx cap add ios` on Windows works — but the tree it writes is not buildable as-is

Running `npx cap add ios` on Windows **succeeds outright**: exit 0, no error, no
warning, no Xcode and no Mac required.

```
[info] All Capacitor plugins have a Package.swift file and will be included in Package.swift
[info] Writing Package.swift
[success] ios platform added!
```

Capacitor 8 wires iOS plugins through **Swift Package Manager, not CocoaPods**.
Verified against the tree on disk in this repo:

| Path | Present? |
|---|---|
| `ios/App/App.xcodeproj/` | yes |
| `ios/App/CapApp-SPM/Package.swift` | yes — declares all four Capacitor plugins |
| `ios/App/Podfile` | **no** |
| `ios/App/Pods/` | **no** |
| `ios/App/App.xcworkspace/` | **no** |

Two consequences, both of which will cost you an afternoon if you meet them the
hard way:

- **There is no `.xcworkspace`, and there never will be one.** Every Capacitor
  tutorial written before v6 tells you to run `pod install` and open
  `App.xcworkspace`. Both are wrong here: `pod install` has no `Podfile` to
  read, and `xcodebuild -workspace App.xcworkspace` fails with *"does not
  exist"*. Use **`-project App.xcodeproj`** — Xcode resolves the Swift packages
  itself, and CocoaPods never needs to be installed on the machine at all.
- **A `Package.swift` generated on Windows does not build on macOS.** The CLI
  writes plugin paths with the host OS's separator, so the file committed from a
  Windows box literally contains
  `path: "..\..\..\node_modules\@capacitor\app"`. Swift cannot parse that.

Both are fixed by the same step: **`npx cap sync ios` regenerates
`Package.swift` with POSIX paths and copies `www/` into `ios/App/App/public`.**

So the rule for every macOS build, CI or local, is: **`npx cap sync ios` first,
`xcodebuild -project App.xcodeproj` second.** That is exactly the order in
`.github/workflows/ios.yml`, and skipping the sync fails on the package
manifest rather than on anything wrong with your code.

### 7.2 The real iOS wall is account and signing, not tooling

A free GitHub Actions macOS runner will happily compile an **unsigned simulator
build** with no Apple account whatsoever. That is exactly what the shipped
workflow does, and it is a genuine compile gate: if it is green, the native side
builds.

What you cannot get for free is a **distributable `.ipa`**. That needs:

- a paid **Apple Developer Program** membership ($99/year), *and*
- an **Apple Distribution certificate** (a `.p12`) plus a matching
  **provisioning profile**, both imported into the build machine's keychain.

No amount of CI cleverness routes around that. The commented block at the bottom
of `.github/workflows/ios.yml` is the exact archive-and-export path for once you
have them, using `apple-actions/import-codesign-certs`.

**Android has no equivalent gate.** A local keystore plus `gradlew.bat
bundleRelease` produces a shippable `.aab` on your Windows machine today, for
free. The $25 Play Console fee is only needed to *publish* it, not to build it.

### 7.3 Your options

Rough costs; all change, so treat every figure as `[VERIFY]` and check the link.

| Option | Rough cost | Gets you |
|---|---|---|
| **The shipped GitHub Actions workflow** | Free for public repos. Private repos bill macOS minutes at a **10×** multiplier against your included allowance. [VERIFY] <https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions> | Proof it compiles. Unsigned simulator build. No `.ipa`. |
| **Rented cloud Mac — MacStadium** | Roughly $100+/month for a dedicated Mac mini. [VERIFY] <https://www.macstadium.com/pricing> | A real Mac you control: Xcode, signing, Archive, TestFlight. |
| **Rented cloud Mac — Scaleway Apple silicon** | Hourly, but with a **24-hour minimum allocation** per instance. [VERIFY] <https://www.scaleway.com/en/pricing/apple-silicon/> | Same, cheaper for bursts. |
| **Rented cloud Mac — AWS EC2 `mac`** | Dedicated Host, hourly, with a **24-hour minimum allocation** — so the smallest sane unit is a full day, not an hour. [VERIFY] <https://aws.amazon.com/ec2/instance-types/mac/> | Same. |
| **Codemagic** | Free tier of macOS build minutes per month, then paid. [VERIFY] <https://codemagic.io/pricing/> | Managed iOS CI with signing/secrets handling built in. |
| **Ionic Appflow** | Paid tiers only. [VERIFY] <https://ionic.io/pricing> | Same, from Capacitor's own vendor. |
| **Borrow a Mac for an afternoon** | Free | Everything below. Genuinely the cheapest first release. |

Note that a paid CI product removes the *tooling* problem, never the *account*
problem: Codemagic and Appflow still need your $99 membership and your
certificates uploaded to them.

### 7.4 When you do have a Mac

macOS commands, in order, from the repo root:

```bash
npm install
npx cap add ios       # skip if ios/ is already in the repo
npx cap sync ios      # MANDATORY — see §7.1: rewrites Package.swift with POSIX
                      # paths and copies www/ into ios/App/App/public
npx cap open ios      # opens ios/App/App.xcodeproj in Xcode
```

**Do not install CocoaPods.** Nothing in this project uses it. The first Xcode
build will pause on *"Resolving Package Graph"* while SPM fetches
`capacitor-swift-pm`; that is normal and happens once.

Then in Xcode:

1. Select the **App** project in the left sidebar, then the **App** target.
2. **Signing & Capabilities** tab → tick **Automatically manage signing** →
   choose your **Team** from the dropdown. (The Team only appears once you have
   added your Apple ID under **Xcode → Settings → Accounts** and that Apple ID
   has a Developer Program membership.)
3. Set the run destination at the top of the window to **Any iOS Device
   (arm64)** — you cannot archive against a simulator.
4. **Product → Archive**. When it finishes, the Organizer window opens.
5. **Distribute App → App Store Connect → Upload**.

---

## 8. Store submission

### Google Play

**$25 one-time** registration fee, paid by card at signup.
<https://support.google.com/googleplay/android-developer/answer/6112435>

You will be asked for:

- **App icon** — 512 × 512 px, 32-bit PNG *with* alpha, ≤ 1024 KB
- **Feature graphic** — 1024 × 500 px, JPEG or 24-bit PNG, **no** alpha
  (mandatory; the listing will not publish without it)
- **Screenshots** — minimum 2 to publish; at least 4 at ≥ 1080 px in 16:9 or 9:16
  to be eligible for Play's recommendation surfaces. Separate sets per form
  factor: phone, 7" tablet, 10" tablet, and Chromebook if you declare support
  (min 4 for large screens)
- **Short description** — ≤ 80 characters
- **Full description** — ≤ 4000 characters
- **Privacy policy URL** — a live, publicly reachable page
- **Data safety form** — see below
- **Content rating questionnaire** (IARC) — see §9
- **Target audience declaration**, and app access instructions if anything is
  gated

Asset specs: <https://support.google.com/googleplay/android-developer/answer/9866151>
Data safety form: <https://support.google.com/googleplay/android-developer/answer/10787469>

**Your data safety answers are simple, because this app collects nothing.** It
makes no network requests, has no analytics, no ads and no accounts; the only
storage is `localStorage` on the device (§6), which never leaves it. So: *no
data collected, no data shared*. You still need a privacy policy URL saying
precisely that — Play requires the URL regardless.

### Apple App Store

**$99/year** Apple Developer Program membership.
<https://developer.apple.com/programs/enroll/> ·
<https://developer.apple.com/support/compare-memberships/>

You will be asked for:

- **App icon** — 1024 × 1024 px, PNG, **no alpha channel, no transparency, no
  rounded corners** (Apple rounds them for you; supply a square)
- **Screenshots** — per display size. Modern App Store Connect requires one set
  for the largest iPhone display and, if you support iPad, one for the largest
  iPad display, then scales down for the rest. [VERIFY] exact required sizes,
  which change with each hardware generation:
  <https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications>
- **Privacy policy URL**
- **App Privacy** answers — the "privacy nutrition label". Same story as Play:
  **Data Not Collected**. <https://developer.apple.com/app-store/app-privacy-details/>
- **Age rating questionnaire** — see §9. This one matters here.
- **Notes for App Review** explaining the app is play-money only (§9)

---

## 9. The section that actually gets apps rejected: gambling policy

**What this app is:** a simulated / social casino. Play money only. No
real-currency wagering, no purchases, no cash-out, no prizes of any real-world
value. The balance is a number in `localStorage` that starts at 1000.

**What that means:** you are *outside* both stores' real-money gambling regimes
— which are the brutal ones, requiring licences, geo-fencing and adult-only
ratings — and *inside* their simulated-gambling rules, which are mostly about
**age rating** and **not lying in your metadata**.

Everything below is quoted or paraphrased from pages fetched on 2026-07-26.
Store policy changes without notice: **re-read the linked pages before you
submit.** Anything I could not confirm from an official page is marked
`[VERIFY]`.

### 9.1 Google Play

**The real-money policy does not apply to you** —
<https://support.google.com/googleplay/android-developer/answer/9877032>

It prohibits "content or services that enable or facilitate users' ability to
wager, stake, or participate using real money (including in-app items purchased
with money) to obtain a prize of real world monetary value". No real money in,
no real value out, so this app is not in scope. The licence/AO-rating/geo-fence
requirements on that page are for licensed operators and are irrelevant here.

**But that same page tells you exactly what gets a simulated casino removed.**
Its list of violations includes apps with "navigational elements or features
(for example, menu items, tabs, buttons, webviews, etc.) that provide a 'call to
action' to wager, stake, or participate in real-money games ... such as apps
that invite users to 'BET!' or 'REGISTER!' or 'COMPETE!' in a tournament for a
chance to win a cash prize." Google is looking at your **buttons and your store
listing copy**, not just your payment code.

Also note, for later: that page's ads section requires that an app carrying
gambling ads "must not provide simulated gambling content". If you ever
monetise with ads, gambling ads are permanently off the table for this app.

**Content rating (IARC)** —
<https://support.google.com/googleplay/android-developer/answer/9859655>

You fill in one questionnaire in Play Console (**Policy → App content → Content
ratings**) and IARC generates ratings for every territory. Answer **yes** to
simulated gambling and **no** to real-money gambling / real prizes.

The rating that produces is a **teen** rating, not an adults-only one — this is
worth knowing because "simulated gambling = AO" is a widespread myth. From the
authorities' own descriptions on that page:

| Authority | Rating carrying simulated gambling |
|---|---|
| ESRB (Americas) | **TEEN** — "may contain ... simulated gambling" |
| PEGI (Europe) | **PEGI 12** — "... and simulated gambling" |
| IARC Generic | **12+** — "... mild language and simulated gambling are also permitted" |
| ESRB | **ADULTS ONLY** is reserved for "gambling with real currency" — not this app |

`[VERIFY]` the exact wording of the questionnaire's gambling questions: IARC
does not publish the question set, so I cannot quote it. Answer it honestly and
take whatever it calculates.

`[VERIFY]` whether simulated gambling disqualifies you from the Families /
Designed-for-Families programme. It plainly should, and you should not target
children regardless, but I could not confirm an explicit clause on the current
page: <https://play.google.com/about/families/>

Set **Target audience** to adults only. Do not tick any child age band.

### 9.2 Apple

**Guideline 5.3 — Gaming, Gambling, and Lotteries** —
<https://developer.apple.com/app-store/review/guidelines/#gaming-gambling-and-lotteries>

Current text, in full, of the parts that could touch you:

- **5.3.3** — "Apps may not use in-app purchase to purchase credit or currency
  for use in conjunction with real money gaming of any kind."
- **5.3.4** — "Apps that offer real money gaming (e.g. sports betting, poker,
  casino games, horse racing) or lotteries must have necessary licensing and
  permissions in the locations where the app is used, must be geo-restricted to
  those locations, and must be free on the App Store."

Neither applies to a play-money app with no IAP. 5.3.3 is the one to remember if
you ever add a "buy more chips" purchase: play-money chips via IAP are fine
precisely *because* they are not real money gaming — but the moment anything is
cashable, 5.3.3 and 5.3.4 both land on you. `[VERIFY]` before adding any IAP.

**Guideline 4.7 — be aware of what it actually says.** The brief for this
document expected 4.7 to cover simulated gambling. It does not. Current 4.7 is
titled "**Mini apps, mini games, streaming games, chatbots, plug-ins, and game
emulators**" and governs "software that is not embedded in the binary,
specifically HTML5 and JavaScript mini apps and mini games". It is worth knowing
for two reasons:

1. **It does not apply to this app, and you should keep it that way.** Capacitor
   bundles all of `www/` *inside* the binary, so nothing is downloaded at
   runtime. That stays true only as long as nobody sets `server.url` in
   `capacitor.config.js` to point the WebView at a remote site. Do not — it
   would drag you under 4.7 (and would move the origin, see §6).
2. **4.7.5 is the shape of age gate Apple likes:** "use an age restriction
   mechanism based on **verified or declared age** to limit access by underage
   users." *Declared* age is acceptable. A date-of-birth prompt satisfies it.

**Age rating** — this is where a casino app lands high.
<https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions>

Apple's content descriptor is **Simulated Gambling**: "Betting or wagering
without using real money or in-game currency that can be exchanged for real
money." Since simulated gambling is the *entire* app, you will be declaring it
as **Frequent**, which yields:

| Scale | Result |
|---|---|
| Current (iOS 26 and later) | **18+** — "Chance-Based Activities: Gambling / Frequent simulated gambling" |
| Legacy (OS versions earlier than 26) | **17+** — "Gambling / Frequent or intense simulated gambling" |
| Apple's 13+ tier | covers **Infrequent** simulated gambling only — not this app |

Two knock-on effects Apple documents on that same page: a 17+ global rating
displays as **18+ in France** (ANFR requirement), and apps in the Games or
Entertainment categories and/or with Frequent/Intense Simulated Gambling get an
extra **GRAC regional rating in South Korea**.

So: the brief's "17+ expectation" is right on the legacy scale and is **18+** on
the current one. Do not fight it — answer honestly. Guideline 2.3.6 makes
mis-rating its own rejection reason.

### 9.3 Concrete actions

Do all five before you submit anywhere.

1. **Age gate on first launch.** A one-time modal asking for date of birth (or,
   at minimum, an explicit "I am 18 or older" confirmation), persisted so it
   asks once. Declared age is sufficient (Apple 4.7.5). Store the flag alongside
   the session — and note §6: it lives in the same origin-scoped
   `localStorage` as everything else.
2. **A permanent "play money only" disclosure.** Not buried in an About modal —
   visible where the balance is, and repeated in the first line of both store
   descriptions. Suggested wording: *"Play money only. No real-currency
   wagering, no purchases, no cash-out, and no prizes of any kind."*
3. **Answer the questionnaires honestly.** Play IARC: simulated gambling **yes**,
   real-money gambling **no**, prizes of real value **no**. App Store Connect:
   Simulated Gambling **Frequent**, Gambling **none**.
4. **Scrub metadata that implies real stakes.** No "win real money", "cash
   prizes", "free bonus", "deposit", "withdraw", "payout", "real casino" in the
   app name, subtitle, short description, screenshots or feature graphic. Google
   explicitly lists call-to-action wording like "BET!" as a violation example;
   Apple's 2.3.1 covers misleading marketing.
5. **Two specific strings in this app's own UI, today.** `index.html` line 100
   ships a button with `id="btn-deposit"`, the label **"Deposit"** and the
   tooltip **"Add $1,000 to your balance"**. That is a literal deposit
   call-to-action with a dollar sign next to it — precisely the pattern both
   review teams scan for. Rename it (**"Add Credits"** / **"Top Up Chips"**) and
   drop the `$` from the tooltip. The per-round **"Cash Out"** buttons (Crash,
   Twist, Hilo, Mines) are standard in-round game terminology and are much lower
   risk, but do not repeat the phrase in store metadata, where it reads as
   withdrawal.

Also put a short note in **App Review Notes** (Apple) and **App access**
(Google): *"Simulated casino. All balances are play money stored locally on the
device. No real-money wagering, no in-app purchases, no cash-out, no network
requests."* Reviewers reject what they have to guess about.

### 9.4 Pages actually fetched for this section

All fetched 2026-07-26, all returned HTTP 200:

- <https://support.google.com/googleplay/android-developer/answer/9877032> — Real-Money Gambling, Games, and Contests
- <https://support.google.com/googleplay/android-developer/answer/9859655> — Content rating requirements (ESRB / PEGI / USK / IARC descriptions)
- <https://support.google.com/googleplay/android-developer/answer/9859455> — Prepare your app for review (App content page)
- <https://support.google.com/googleplay/android-developer/answer/9866151> — Preview asset specs
- <https://support.google.com/googleplay/android-developer/answer/6112435> — Play Console registration and the $25 fee
- <https://developer.apple.com/app-store/review/guidelines/> — App Review Guidelines (4.7, 5.3 quoted above)
- <https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions> — age rating tiers and the Simulated Gambling descriptor

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: JAVA_HOME is not set and no 'java' command could be found` | Gradle cannot find a JDK, or you are in a terminal opened before `setx` ran. | Close the terminal, open a new one, `echo %JAVA_HOME%`. Empty → redo §2.4 with your real JDK folder name. Set → check `%JAVA_HOME%\bin\java.exe` actually exists (a version-number typo is the usual culprit). |
| `Failed to find target with hash string 'android-35'` / `compileSdkVersion 36 requires JDK 17` / any "SDK version" mismatch | The Android SDK platform Gradle wants is not installed, or your JDK is too old. | Open `android/variables.gradle` and read `compileSdkVersion`. Install exactly that platform via SDK Manager (§2.3). If the error names a JDK version, you are on JDK < 17 — install Temurin 21 (§2.1). |
| Edits to HTML/CSS/JS do not show up in the app | You edited `www/` — which is **generated** — or you skipped the sync. | `www/` is rebuilt from scratch by `node scripts/build-www.mjs` on every `npm run sync`; anything you type there is deleted on the next run. Edit `index.html`, `styles.css`, `css/**`, `js/**` in the **repo root**, then `npm run sync`, then re-run from Android Studio. |
| App launches to a **blank white screen** | A JS error before first paint, or `www/` was never generated. | Chrome on the PC → `chrome://inspect/#devices` → your device → **inspect** under the app's WebView. You get a real DevTools console against the phone. Read the first error. If the console shows 404s for `js/app.js`, `www/` is empty or stale — run `npm run build` and check the files landed. |
| **All player balances and profiles reset to defaults after an app update** | The WebView origin changed — someone edited `server.androidScheme`, `server.iosScheme` or `server.hostname` in `capacitor.config.js`. `localStorage` is origin-partitioned, so the old data is now under an origin nothing reads. | Revert the config to `androidScheme: 'https'`, `iosScheme: 'capacitor'`, `hostname: 'localhost'` and ship that. The data is **orphaned, not deleted** — restoring the original origin restores every balance and profile. See §6, and never touch those three keys again. |
| App icon/name are wrong, or the app behaves as if `capacitor.config.js` is empty (and the balance resets) | Somebody converted the config from top-level named exports to `export default { … }`. Capacitor 8's `.js` loader does not unwrap `.default`, so every key becomes invisible and the app builds on Capacitor's defaults — silently, including a different origin. | Convert it back to `export const appId = …` / `export const server = …`. Run `npm run check`, which asserts exactly this. See §6. |
| `xcodebuild: error: ... 'App.xcworkspace' does not exist` (or `pod install` reports no Podfile) | You followed a pre-v6 Capacitor tutorial. Capacitor 8 is **SPM-based**: there is no Podfile, no `Pods/` and no workspace — only `ios/App/App.xcodeproj`. | Build with `-project App.xcodeproj`, not `-workspace App.xcworkspace`, and do not install CocoaPods. See §7.1. |
| On macOS, the build fails inside `CapApp-SPM/Package.swift` with an invalid-path or invalid-escape error | The `ios/` tree was generated on Windows, so the plugin paths in `Package.swift` use backslashes (`..\..\..\node_modules\@capacitor\app`), which Swift cannot parse. | Run `npx cap sync ios` on the Mac **before** `xcodebuild`. It regenerates the manifest with POSIX paths. This is why the shipped workflow syncs first. |
| Live reload connects but the page never loads on the phone | Phone is on a different network, or Windows Firewall is blocking Node. | Same Wi-Fi; set the PC's Wi-Fi profile to **Private**; allow Node.js through Windows Defender Firewall on private networks. See §3.4. |
| `adb devices` shows nothing, or `unauthorized` | Missing USB driver, a charge-only cable, or the debugging prompt was dismissed. | Install **Google USB Driver** (§2.3). Try a different cable. Unplug/replug and accept **"Allow USB debugging?"** on the phone, ticking *Always allow*. `adb kill-server && adb devices` forces a re-detect. |
| `npm ci` fails in CI with `package-lock.json` not found | The lockfile is not committed. | Run `npm install` locally once and commit `package-lock.json`. `npm ci` requires it by design — that is the point of it. |

---

## Related files

- `AGENTS.md` — how the web app itself is built. Read §3 (money path) and §5
  (canvas theme) before changing any game.
- `capacitor.config.js` — native config. Read the comment above `server` (§6).
- `scripts/build-www.mjs` — the `www/` generator.
- `scripts/check.mjs` — `npm run check`: `node --check` over `js/**` plus the
  `capacitor.config.js` audit. This replaces the bash `for` loop in AGENTS.md §1,
  which silently no-ops on Windows.
- `js/native.js` — the only file in `js/` that knows Capacitor exists. It no-ops
  in a plain browser, which is why `python -m http.server 8080` still works.
- `.github/workflows/android.yml` — CI debug APK.
- `.github/workflows/ios.yml` — CI unsigned simulator build.
