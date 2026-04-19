import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js";
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js";

const firebaseConfig = {
  projectId: "subkit-auth-prod",
  appId: "1:835838304162:web:9924e3482f99b054901cfb",
  storageBucket: "subkit-auth-prod.firebasestorage.app",
  apiKey: "AIzaSyBqqOxHjxKUIRoF5A1ldtu7lH73vSJ8j8s",
  authDomain: "subkit-auth-prod.firebaseapp.com",
  messagingSenderId: "835838304162",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

window.signInWithGoogle = async () => {
  const btn = document.getElementById("google-btn");
  const status = document.getElementById("status");
  btn.disabled = true;
  status.className = "status wait";
  status.textContent = "Signing in...";

  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    const idToken = await result.user.getIdToken();

    const params = new URLSearchParams(window.location.search);
    const callbackPort = params.get("callback_port");
    const callbackState = params.get("state");

    if (callbackPort) {
      status.className = "status wait";
      status.textContent = "Sending credentials to CLI...";
      const callbackUrl = new URL(`http://localhost:${callbackPort}/callback`);
      callbackUrl.searchParams.set("id_token", idToken);
      callbackUrl.searchParams.set(
        "issuer",
        `https://securetoken.google.com/${firebaseConfig.projectId}`,
      );
      callbackUrl.searchParams.set("email", result.user.email || "");
      if (callbackState) callbackUrl.searchParams.set("state", callbackState);
      window.location.href = callbackUrl.toString();
      return;
    }

    status.className = "status ok";
    status.textContent = `Signed in as ${result.user.email}`;
  } catch (err) {
    status.className = "status err";
    status.textContent = err.message;
    btn.disabled = false;
  }
};
