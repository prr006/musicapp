// Command server runs the hosted MELO HTTP API. It deliberately has no Wails
// dependency at runtime: `go run ./server` is the complete browser backend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"melo/internal/deps"
	"melo/internal/lyrics"
	"melo/internal/media"
	"melo/internal/provider"
	"melo/server/api"
	"melo/server/auth"
	"melo/server/config"
	accountstore "melo/server/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		logger.Error("create data directory", "error", err)
		os.Exit(1)
	}

	dependencyManager, err := deps.NewManager(filepath.Join(cfg.DataDir, "bin"))
	if err != nil {
		logger.Error("configure resolver", "error", err)
		os.Exit(1)
	}
	resolverPath := func() (string, error) { return dependencyManager.Ensure(nil) }
	runner := provider.Exec{Path: resolverPath}
	searchProvider := provider.New(runner)
	resolver := media.NewResolver(runner)
	streamer := media.NewStreamer(resolver)
	streamer.SetFailureObserver(func(failure media.StreamFailure) {
		logger.Error("playback stream failure",
			"stage", failure.Stage,
			"source_id", failure.SourceID,
			"request_id", failure.RequestID,
			"upstream_status", failure.Status,
			"failure", failure.Failure,
		)
	})
	lyricsProvider := lyrics.New()
	accounts := accountstore.NewFileRepository(cfg.DataDir)
	authService, err := auth.New(cfg.SessionSecret, cfg.CookieSecure, cfg.DataDir)
	if err != nil {
		logger.Error("configure authentication", "error", err)
		os.Exit(1)
	}

	handler := api.New(api.Dependencies{
		Config: cfg, Auth: authService, Accounts: accounts, Provider: searchProvider,
		Resolver: resolver, Streamer: streamer, Lyrics: lyricsProvider,
		ResolverInfo: dependencyManager.Status, Logger: logger,
	})
	httpServer := &http.Server{
		Addr: cfg.Addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 0, IdleTimeout: 75 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("MELO API listening", "address", cfg.Addr)
		serverErrors <- httpServer.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-signals:
		logger.Info("shutdown requested", "signal", sig.String())
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server stopped", "error", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown", "error", err)
	}
	if err := accounts.Close(); err != nil {
		logger.Error("flush account storage", "error", err)
	}
}
