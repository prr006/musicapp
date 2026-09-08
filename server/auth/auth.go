package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"net/http"

	"golang.org/x/crypto/bcrypt"
)

const cookieName = "melo_session"

var (
	ErrCredentials = errors.New("invalid username or password")
	ErrUserExists  = errors.New("that username is already registered")
	usernameRE     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$`)
)

type Identity struct {
	Subject       string `json:"-"`
	UserID        string `json:"id,omitempty"`
	Username      string `json:"username,omitempty"`
	Authenticated bool   `json:"authenticated"`
}

type session struct {
	Subject  string `json:"sub"`
	UserID   string `json:"uid,omitempty"`
	Username string `json:"name,omitempty"`
	Expires  int64  `json:"exp"`
}

type userRecord struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	CreatedAt    int64  `json:"createdAt"`
}

type registryFile struct {
	Users []userRecord `json:"users"`
}

type Service struct {
	secret       []byte
	cookieSecure bool
	path         string
	mu           sync.Mutex
	users        map[string]userRecord // normalized username -> record
}

type contextKey struct{}

func New(secret []byte, cookieSecure bool, dataDir string) (*Service, error) {
	s := &Service{
		secret:       append([]byte(nil), secret...),
		cookieSecure: cookieSecure,
		path:         filepath.Join(dataDir, "auth", "users.json"),
		users:        make(map[string]userRecord),
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// Middleware establishes either an authenticated identity or an isolated
// anonymous identity. Anonymous users therefore get persistent libraries
// without being silently treated as one shared public account.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity, ok := s.fromRequest(r)
		if !ok {
			identity = s.newAnonymous(w)
		}
		ctx := context.WithValue(r.Context(), contextKey{}, identity)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func FromContext(ctx context.Context) Identity {
	identity, _ := ctx.Value(contextKey{}).(Identity)
	return identity
}

func (s *Service) Register(w http.ResponseWriter, username, password string) (Identity, error) {
	username = strings.TrimSpace(username)
	if !usernameRE.MatchString(username) {
		return Identity{}, errors.New("username must be 3–64 letters, numbers, dots, dashes, or underscores")
	}
	if len(password) < 8 || len(password) > 128 {
		return Identity{}, errors.New("password must be between 8 and 128 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return Identity{}, err
	}
	record := userRecord{ID: randomID(), Username: username, PasswordHash: string(hash), CreatedAt: time.Now().UnixMilli()}
	key := normalizeUsername(username)

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.users[key]; exists {
		return Identity{}, ErrUserExists
	}
	s.users[key] = record
	if err := s.flushLocked(); err != nil {
		delete(s.users, key)
		return Identity{}, err
	}
	identity := identityFor(record)
	s.setCookie(w, sessionFor(identity))
	return identity, nil
}

func (s *Service) Login(w http.ResponseWriter, username, password string) (Identity, error) {
	s.mu.Lock()
	record, ok := s.users[normalizeUsername(username)]
	s.mu.Unlock()
	if !ok || bcrypt.CompareHashAndPassword([]byte(record.PasswordHash), []byte(password)) != nil {
		return Identity{}, ErrCredentials
	}
	identity := identityFor(record)
	s.setCookie(w, sessionFor(identity))
	return identity, nil
}

func (s *Service) Logout(w http.ResponseWriter) Identity {
	return s.newAnonymous(w)
}

func identityFor(record userRecord) Identity {
	return Identity{Subject: "user:" + record.ID, UserID: record.ID, Username: record.Username, Authenticated: true}
}

func sessionFor(identity Identity) session {
	return session{
		Subject: identity.Subject, UserID: identity.UserID, Username: identity.Username,
		Expires: time.Now().Add(365 * 24 * time.Hour).Unix(),
	}
}

func (s *Service) newAnonymous(w http.ResponseWriter) Identity {
	identity := Identity{Subject: "anon:" + randomID(), Authenticated: false}
	s.setCookie(w, sessionFor(identity))
	return identity
}

func (s *Service) fromRequest(r *http.Request) (Identity, bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return Identity{}, false
	}
	payload, ok := s.verify(cookie.Value)
	if !ok || payload.Expires < time.Now().Unix() || payload.Subject == "" {
		return Identity{}, false
	}
	if strings.HasPrefix(payload.Subject, "anon:") {
		return Identity{Subject: payload.Subject}, true
	}
	if !strings.HasPrefix(payload.Subject, "user:") || payload.UserID == "" {
		return Identity{}, false
	}
	// Sessions refer to immutable user ids. Confirm the account still exists and
	// source the display name from server storage rather than trusting a cookie.
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, user := range s.users {
		if user.ID == payload.UserID {
			return identityFor(user), true
		}
	}
	return Identity{}, false
}

func (s *Service) setCookie(w http.ResponseWriter, payload session) {
	sameSite := http.SameSiteLaxMode
	if s.cookieSecure {
		// Vercel and Railway preview domains are cross-site. None+Secure allows
		// credentialed API fetches while CORS still restricts exact origins.
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: s.sign(payload), Path: "/", MaxAge: 365 * 24 * 60 * 60,
		Expires: time.Unix(payload.Expires, 0), HttpOnly: true, Secure: s.cookieSecure,
		SameSite: sameSite,
	})
}

func (s *Service) sign(payload session) string {
	raw, _ := json.Marshal(payload)
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(encoded))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + sig
}

func (s *Service) verify(value string) (session, bool) {
	encoded, signature, ok := strings.Cut(value, ".")
	if !ok {
		return session{}, false
	}
	provided, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return session{}, false
	}
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(encoded))
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return session{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return session{}, false
	}
	var payload session
	if json.Unmarshal(raw, &payload) != nil {
		return session{}, false
	}
	return payload, true
}

func (s *Service) load() error {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read user registry: %w", err)
	}
	var file registryFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return fmt.Errorf("read user registry: %w", err)
	}
	for _, user := range file.Users {
		s.users[normalizeUsername(user.Username)] = user
	}
	return nil
}

func (s *Service) flushLocked() error {
	file := registryFile{Users: make([]userRecord, 0, len(s.users))}
	for _, user := range s.users {
		file.Users = append(file.Users, user)
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func normalizeUsername(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func randomID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value[:])
}
