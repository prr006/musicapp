package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app, err := NewApp()
	if err != nil {
		fmt.Fprintf(os.Stderr, "MELO failed to start: %v\n", err)
		os.Exit(1)
	}

	err = wails.Run(&options.App{
		Title:            "MELO",
		Width:            1240,
		Height:           820,
		MinWidth:         960,
		MinHeight:        640,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 12, G: 12, B: 14, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []any{app},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			// Autoplay must be allowed or the media element refuses to start
			// without a user gesture inside the webview.
			WebviewBrowserPath: "",
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "MELO exited with an error: %v\n", err)
		os.Exit(1)
	}
}
