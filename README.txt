DAKSHINA AI — NETLIFY SHARED-KEY EDITION
========================================

This package is prepared for Netlify. All visitors use one Gemini API connection owned by the site owner. Visitors do not enter API keys. The Gemini key is kept in Netlify's server-side environment and is never sent to the browser.

IMPORTANT SECURITY NOTE
The API key previously pasted into ChatGPT must be treated as exposed. Revoke/delete that key in Google AI Studio, create a NEW key, and use only the new key in Netlify. Do not put the key in any file, GitHub repository, or this ZIP.

WHAT'S INCLUDED
- site/: the public website files
- netlify/functions/chat.js: private serverless Gemini endpoint
- netlify.toml: Netlify build, function, and /api routing configuration
- server.js: optional local Node.js server for testing on your computer
- .env.example: local-only example; contains no real key

PUBLISH ON NETLIFY (NO TERMINAL / NO CODING)
1. Extract this ZIP on your computer.
2. Open https://github.com and sign in (or create a free account).
3. Create a new repository named dakshina-ai. Set it to Private if you prefer.
4. In that repository, choose Add file > Upload files. Upload the CONTENTS of the extracted dakshina-ai-package folder (not the ZIP itself). Make sure netlify.toml, site/, and netlify/ are at the repository's top level. Commit the upload.
5. Open https://app.netlify.com and sign in.
6. Choose Add new project / Import an existing project > GitHub, authorize GitHub if asked, and select dakshina-ai.
7. Netlify should detect netlify.toml. Keep the publish directory as site and the functions directory as netlify/functions. Start the deploy.
8. In Netlify, open your new site's Site configuration (or Project configuration) > Environment variables > Add a variable.
   Name: GEMINI_API_KEY
   Value: paste your NEW Google Gemini API key
   Make sure the variable is available to Functions / all scopes.
9. Save the variable, then go to Deploys and choose Trigger deploy > Deploy site.
10. Open your Netlify site URL. The header should report that the shared server is online.

The key is not stored in the GitHub repository. It is stored by Netlify and read only inside the serverless function. Do not add GEMINI_API_KEY to netlify.toml or any browser-side variable such as VITE_*, NEXT_PUBLIC_*, or PUBLIC_*.

MODEL SETTINGS
Default: gemini-3.5-flash-lite
Fallbacks: gemini-3.8-flash, gemini-3.6-flash
These are current Gemini API model IDs at the time this package was prepared. Model availability, free quota, and pricing depend on Google's account and project settings. The fallbacks may also consume quota.

LOCAL TEST (OPTIONAL)
Requires Node.js 20+.
1. Copy .env.example to .env and put a NEW key in GEMINI_API_KEY.
2. Run npm start in this folder.
3. Open http://localhost:8080.

PUBLIC SHARED-KEY WARNING
Anyone can use the public chat, and requests consume YOUR Gemini quota. The included per-IP rate limit is a basic best-effort safeguard; serverless instances may reset or run independently. Monitor Google AI Studio / Cloud usage and billing, and disable or rotate the key if abuse occurs. Do not assume Google's free quota is unlimited.

This ZIP is prepared for deployment, but it has not been published to your Netlify account. You must complete the account steps above and provide the newly rotated key directly to Netlify.
