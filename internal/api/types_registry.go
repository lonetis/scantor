package api

// Wire types of the registry token endpoint (/api/registry/token, docs/api.md §6). Docker daemons call
// it, never scantor's Go code; the types document the contract and serve tests.

// Registry token constants.
const (
	RegistryService  = "scantor-registry"
	RegistryIssuer   = "scantor"
	RegistryTokenTTL = 300

	// RegistryNodeUsername is the Basic username of node credentials (password: the node token).
	RegistryNodeUsername = "node"
	// RegistryOrchestratorUsername is the Basic username of the push credential (password:
	// base64url(key("registry-push"))).
	RegistryOrchestratorUsername = "orchestrator"
)

// RegistryTokenResponse is the response of both flows: the GET flow sets Token and AccessToken, the
// POST (OAuth2 password grant) flow sets AccessToken only. No refresh token is issued.
type RegistryTokenResponse struct {
	Token       string `json:"token,omitempty"`
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	IssuedAt    string `json:"issued_at"`
}

// RegistryAccess is one granted scope of a registry token.
type RegistryAccess struct {
	Type    string   `json:"type"`
	Name    string   `json:"name"`
	Actions []string `json:"actions"`
}

// RegistryTokenClaims are the JWT claims of a registry token (ES256, header kid = JWKS kid).
type RegistryTokenClaims struct {
	Issuer    string           `json:"iss"`
	Subject   string           `json:"sub"`
	Audience  string           `json:"aud"`
	IssuedAt  int64            `json:"iat"`
	NotBefore int64            `json:"nbf"`
	ExpiresAt int64            `json:"exp"`
	JWTID     string           `json:"jti"`
	Access    []RegistryAccess `json:"access"`
}

// RegistryError is one entry of the registry error format `{"errors": [{"code", "message"}]}`.
type RegistryError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
