export const AUTH_FILENAME = '.dsh-antigravity-oauth.json'

export const HARNESS_ROUTE = 'agy-google-antigravity'

export const BOOT_MARKER = '[my-plugins/dsh-antigravity-oauth] loaded'

export const STREAM_IDLE_TIMEOUT_MS = 300_000

export const AUTH_STATUS_PATH = '/plugins/dsh-antigravity-oauth/auth/status'
export const AUTH_LOGIN_PATH = '/plugins/dsh-antigravity-oauth/auth/login'
export const AUTH_COMPLETE_PATH = '/plugins/dsh-antigravity-oauth/auth/complete'
export const AUTH_LOGOUT_PATH = '/plugins/dsh-antigravity-oauth/auth/logout'

export const DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
export const SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const CCA_ENDPOINTS = [DAILY_ENDPOINT, SANDBOX_ENDPOINT] as const

export const STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse'

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'

export const CALLBACK_PORT = 51121
export const CALLBACK_PATH = '/oauth-callback'
export const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

export const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist'
export const ONBOARD_USER_PATH = '/v1internal:onboardUser'

export const FREE_TIER_ID = 'free-tier'
export const ONBOARD_TIMEOUT_MS = 30_000
export const ONBOARD_POLL_INTERVAL_MS = 1_000

export const IMAGE_MODEL = 'gemini-3-pro-image'

export const DEFAULT_ANTIGRAVITY_VERSION = '2.11.0'
export const DEFAULT_ANTIGRAVITY_CL = '963137146'

export const ANTIGRAVITY_VERSION_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml'

export const OAUTH_REFRESH_SOON_MS = 15 * 60 * 1000
export const OAUTH_REFRESH_POLL_MS = 15 * 60 * 1000
export const OAUTH_REFRESH_COOLDOWN_MS = 5 * 60 * 1000
export const OAUTH_EXPIRES_SKEW_MS = 5 * 60 * 1000
