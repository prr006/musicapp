package config

import (
	"strings"
	"testing"
)

func setValidProductionEnv(t *testing.T) {
	t.Helper()
	t.Setenv("MELO_ENV", "production")
	t.Setenv("MELO_DATA_DIR", t.TempDir())
	t.Setenv("CORS_ORIGINS", "https://melo.example.com")
	t.Setenv("SESSION_SECRET", "01234567890123456789012345678901")
	t.Setenv("PLAYBACK_SIGNING_KEY", "abcdefghijklmnopqrstuvwxyzABCDEF")
	t.Setenv("COOKIE_SECURE", "true")
	t.Setenv("TRUST_PROXY_HEADERS", "true")
}

func TestRailwayPortOverridesImageAddressAndBindsAllInterfaces(t *testing.T) {
	setValidProductionEnv(t)
	t.Setenv("ADDR", ":8080")
	t.Setenv("PORT", "43721")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "0.0.0.0:43721" {
		t.Fatalf("expected Railway PORT binding, got %q", cfg.Addr)
	}
}

func TestAddressFallsBackWhenPlatformPortIsAbsent(t *testing.T) {
	setValidProductionEnv(t)
	t.Setenv("PORT", "")
	t.Setenv("ADDR", ":9090")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":9090" {
		t.Fatalf("expected ADDR fallback, got %q", cfg.Addr)
	}
}

func TestInvalidPlatformPortFailsFast(t *testing.T) {
	setValidProductionEnv(t)
	t.Setenv("PORT", "not-a-port")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "PORT") {
		t.Fatalf("expected a PORT validation error, got %v", err)
	}
}
