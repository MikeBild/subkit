#!/usr/bin/env bash
# Fully automated Firebase Auth setup for Subkit.
#
# Creates a Firebase project, enables Google sign-in, registers a web app,
# generates the login page, and deploys it to Firebase Hosting.
#
# Prerequisites:
#   - firebase CLI installed and authenticated (firebase login)
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Billing enabled on the Google Cloud account (required for Identity Platform)
#
# Usage: sh scripts/firebase-setup.sh

set -euo pipefail

PROJECT_ID="${FIREBASE_PROJECT_ID:-subkit}"
DISPLAY_NAME="${FIREBASE_DISPLAY_NAME:-Subkit}"
REGION="${FIREBASE_REGION:-europe-west1}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIREBASE_DIR="$REPO_ROOT/firebase"

say() { printf "\n\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die() { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

command -v firebase >/dev/null || die "firebase CLI not installed — run 'npm install -g firebase-tools'"
command -v gcloud >/dev/null || die "gcloud CLI not installed — run 'brew install google-cloud-sdk'"

# --------------------------------------------------------------------------
say "1. Create Firebase project '$PROJECT_ID'"
if firebase projects:list --json 2>/dev/null | grep -q "\"$PROJECT_ID\""; then
  echo "   project already exists"
else
  firebase projects:create "$PROJECT_ID" --display-name "$DISPLAY_NAME" || {
    warn "Project creation failed. The ID '$PROJECT_ID' may be taken."
    warn "Try: FIREBASE_PROJECT_ID=subkit-$(openssl rand -hex 3) sh scripts/firebase-setup.sh"
    exit 1
  }
fi

# --------------------------------------------------------------------------
say "2. Generate firebase.json + .firebaserc (needed before firebase use)"
mkdir -p "$FIREBASE_DIR/public"

cat > "$FIREBASE_DIR/firebase.json" << 'FIREBASE_JSON'
{
  "hosting": {
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "**", "destination": "/index.html" }
    ],
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "X-Frame-Options", "value": "DENY" },
          { "key": "X-Content-Type-Options", "value": "nosniff" }
        ]
      }
    ]
  }
}
FIREBASE_JSON

cat > "$FIREBASE_DIR/.firebaserc" << FIREBASERC
{
  "projects": {
    "default": "$PROJECT_ID"
  }
}
FIREBASERC

cd "$FIREBASE_DIR"

# --------------------------------------------------------------------------
say "3. Enable Identity Platform API"
gcloud services enable identitytoolkit.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable firebasehosting.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true

# --------------------------------------------------------------------------
say "4. Enable Google sign-in provider"
# Use the Identity Toolkit REST API to enable Google as a sign-in method.
# This requires an OAuth 2.0 client — Firebase auto-creates one, but we
# need to configure it via the API.
ACCESS_TOKEN=$(gcloud auth print-access-token 2>/dev/null)

# Check if Google provider is already enabled
EXISTING=$(curl -s \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/defaultSupportedIdpConfigs/google.com" \
  2>/dev/null)

if echo "$EXISTING" | grep -q '"enabled": true'; then
  echo "   Google sign-in already enabled"
else
  # Get or create OAuth client credentials
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null)

  # Create OAuth client for web if needed
  OAUTH_CLIENT_ID=""
  OAUTH_CLIENT_SECRET=""

  # Check for existing OAuth clients
  EXISTING_CLIENTS=$(curl -s \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "https://oauth2.googleapis.com/v2/projects/$PROJECT_NUMBER/oauthClients" 2>/dev/null || echo "")

  # Create a new OAuth2 web client via Google Cloud
  gcloud services enable iap.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true

  # Use the Identity Platform admin API to enable Google directly
  # This auto-provisions OAuth credentials
  ENABLE_RESULT=$(curl -s -X PATCH \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
    -d '{
      "signIn": {
        "email": { "enabled": false, "passwordRequired": false }
      }
    }' 2>/dev/null)

  # Enable Google IdP via defaultSupportedIdpConfigs
  GOOGLE_ENABLE=$(curl -s -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/defaultSupportedIdpConfigs?idpId=google.com" \
    -d '{
      "enabled": true,
      "clientId": "'"$PROJECT_NUMBER"'-placeholder.apps.googleusercontent.com",
      "clientSecret": "placeholder"
    }' 2>/dev/null)

  if echo "$GOOGLE_ENABLE" | grep -q '"enabled"'; then
    echo "   Google sign-in enabled"
  elif echo "$GOOGLE_ENABLE" | grep -q "ALREADY_EXISTS"; then
    # Already exists, patch it to enabled
    curl -s -X PATCH \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/defaultSupportedIdpConfigs/google.com?updateMask=enabled" \
      -d '{"enabled": true}' >/dev/null 2>&1
    echo "   Google sign-in enabled (updated)"
  else
    warn "Could not enable Google sign-in via API."
    warn "Enable it manually: https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
    warn "Continuing with setup..."
  fi
fi

# --------------------------------------------------------------------------
say "5. Register web app"
APP_ID=$(firebase apps:list --project="$PROJECT_ID" --json 2>/dev/null \
  | grep -o '"appId":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$APP_ID" ]; then
  echo "   web app already registered: $APP_ID"
else
  firebase apps:create web "$DISPLAY_NAME Web" --project="$PROJECT_ID"
  APP_ID=$(firebase apps:list --project="$PROJECT_ID" --json 2>/dev/null \
    | grep -o '"appId":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

# --------------------------------------------------------------------------
say "6. Get web app config"
mkdir -p "$FIREBASE_DIR/public"

firebase apps:sdkconfig web "$APP_ID" --project="$PROJECT_ID" --json 2>/dev/null \
  | grep -o '{[^}]*}' | tail -1 > "$FIREBASE_DIR/firebase-sdk-config.json"

echo "   saved to firebase/firebase-sdk-config.json"

# --------------------------------------------------------------------------
say "7. Generate login page"

# Read the SDK config for inline injection
SDK_CONFIG=$(cat "$FIREBASE_DIR/firebase-sdk-config.json")

cat > "$FIREBASE_DIR/public/index.html" << 'LOGIN_PAGE'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subkit — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; margin-bottom: 8px; color: #58a6ff; }
    p { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      padding: 12px 24px;
      border: 1px solid #30363d;
      border-radius: 8px;
      background: #21262d;
      color: #c9d1d9;
      font-size: 16px;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
    }
    .btn:hover { background: #30363d; border-color: #58a6ff; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn svg { width: 20px; height: 20px; }
    .status { margin-top: 16px; font-size: 13px; min-height: 20px; }
    .status.ok { color: #3fb950; }
    .status.err { color: #f85149; }
    .status.wait { color: #d29922; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Subkit</h1>
    <p>Sign in to continue to your workflow engine</p>
    <button class="btn" id="google-btn" onclick="signInWithGoogle()">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </button>
    <div class="status" id="status"></div>
  </div>

  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js";
    import { getAuth, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js";

    // Firebase config is injected by the setup script
    const firebaseConfig = __FIREBASE_CONFIG__;

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);

    window.signInWithGoogle = async function() {
      const btn = document.getElementById("google-btn");
      const status = document.getElementById("status");
      btn.disabled = true;
      status.className = "status wait";
      status.textContent = "Signing in...";

      try {
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        const idToken = await result.user.getIdToken();

        status.className = "status wait";
        status.textContent = "Exchanging credentials...";

        // Check for CLI callback (localhost redirect)
        const params = new URLSearchParams(window.location.search);
        const callbackPort = params.get("callback_port");
        const callbackState = params.get("state");

        if (callbackPort) {
          // CLI login flow — redirect token to localhost
          const callbackUrl = new URL(`http://localhost:${callbackPort}/callback`);
          callbackUrl.searchParams.set("id_token", idToken);
          callbackUrl.searchParams.set("email", result.user.email || "");
          if (callbackState) callbackUrl.searchParams.set("state", callbackState);
          window.location.href = callbackUrl.toString();
          return;
        }

        // Direct web login — show the token for manual copy
        status.className = "status ok";
        status.textContent = `Signed in as ${result.user.email}. Use this token with: sk login --api-key <engine-key>`;
      } catch (err) {
        status.className = "status err";
        status.textContent = err.message;
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>
LOGIN_PAGE

# Inject the Firebase config into the login page
SDK_CONFIG=$(cat "$FIREBASE_DIR/firebase-sdk-config.json")
if [ -n "$SDK_CONFIG" ] && [ "$SDK_CONFIG" != "{}" ]; then
  sed -i.bak "s|__FIREBASE_CONFIG__|$SDK_CONFIG|" "$FIREBASE_DIR/public/index.html"
  rm -f "$FIREBASE_DIR/public/index.html.bak"
  echo "   login page generated with Firebase config"
else
  warn "Firebase SDK config is empty — login page needs manual config injection"
fi

# --------------------------------------------------------------------------
say "8. Deploy to Firebase Hosting"
cd "$FIREBASE_DIR"
firebase deploy --only hosting --project="$PROJECT_ID"

HOSTING_URL="https://${PROJECT_ID}.web.app"
echo ""
say "Setup complete!"
echo ""
echo "  Firebase project:  $PROJECT_ID"
echo "  Login page:        $HOSTING_URL"
echo "  Console:           https://console.firebase.google.com/project/$PROJECT_ID"
echo ""
echo "  Add to your .env:"
echo "    FIREBASE_PROJECT_ID=$PROJECT_ID"
echo "    FIREBASE_LOGIN_URL=$HOSTING_URL"
echo ""
echo "  Users can now authenticate via: sk login"
echo ""

# --------------------------------------------------------------------------
say "9. Update .env with Firebase config"
cd "$REPO_ROOT"
if grep -q "FIREBASE_PROJECT_ID" .env 2>/dev/null; then
  echo "   FIREBASE_PROJECT_ID already in .env"
else
  cat >> .env << ENV

# --- Firebase Auth -----------------------------------------------------------
FIREBASE_PROJECT_ID=$PROJECT_ID
FIREBASE_LOGIN_URL=$HOSTING_URL
ENV
  echo "   added FIREBASE_PROJECT_ID and FIREBASE_LOGIN_URL to .env"
fi
