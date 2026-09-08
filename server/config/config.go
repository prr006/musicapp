package config

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr              string
	DataDir           string
	CORSOrigins       []string
	SessionSecret     []byte
	PlaybackSecret    []byte
	CookieSecure      bool
	TrustProxyHeaders bool
	ResolveTimeout    time.Duration
	SearchTimeout     time.Duration
	LyricsTimeout     time.Duration
}

func Load() (Config, error) {
	addr, err := listenAddress()
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		Addr:           addr,
		DataDir:        env("MELO_DATA_DIR", "./data"),
		CORSOrigins:    splitCSV(env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")),
		CookieSecure:   envBool("COOKIE_SECURE", false),
		ResolveTimeout: duration("RESOLVE_TIMEOUT", 45*time.Second),
		SearchTimeout:  duration("SEARCH_TIMEOUT", 20*time.Second),
		LyricsTimeout:  duration("LYRICS_TIMEOUT", 15*time.Second),
	}
	cfg.TrustProxyHeaders = envBool("TRUST_PROXY_HEADERS", false)

	production := strings.EqualFold(os.Getenv("MELO_ENV"), "production")
	var generated bool
	cfg.SessionSecret, generated = secret("SESSION_SECRET")
	if generated && production {
		return Config{}, fmt.Errorf("SESSION_SECRET is required in production")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, fmt.Errorf("SESSION_SECRET must contain at least 32 bytes")
	}
	cfg.PlaybackSecret, generated = secret("PLAYBACK_SIGNING_KEY")
	if generated && production {
		return Config{}, fmt.Errorf("PLAYBACK_SIGNING_KEY is required in production")
	}
	if len(cfg.PlaybackSecret) < 32 {
		return Config{}, fmt.Errorf("PLAYBACK_SIGNING_KEY must contain at least 32 bytes")
	}
	if len(cfg.CORSOrigins) == 0 {
		return Config{}, fmt.Errorf("CORS_ORIGINS must contain at least one frontend origin")
	}
	for _, origin := range cfg.CORSOrigins {
		if origin == "*" {
			return Config{}, fmt.Errorf("CORS_ORIGINS cannot contain * because MELO uses credentials")
		}
	}
	return cfg, nil
}

func listenAddress() (string, error) {
	// Railway and similar platforms route to their injected PORT. It must win
	// over the image's ADDR fallback so the service binds to the port selected
	// for this allocation, on every interface rather than loopback.
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		return env("ADDR", ":8080"), nil
	}
	parsed, err := strconv.ParseUint(port, 10, 16)
	if err != nil || parsed == 0 {
		return "", fmt.Errorf("PORT must be a number between 1 and 65535")
	}
	return "0.0.0.0:" + strconv.FormatUint(parsed, 10), nil
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func duration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func splitCSV(raw string) []string {
	var result []string
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(strings.TrimRight(item, "/")); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func secret(key string) ([]byte, bool) {
	if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
		if decoded, err := base64.RawURLEncoding.DecodeString(raw); err == nil && len(decoded) >= 32 {
			return decoded, false
		}
		return []byte(raw), false
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return buf, true
}
