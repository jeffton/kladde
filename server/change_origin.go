package main

import (
	"net/http"
	"strings"
)

const changeOriginHeader = "X-Kladde-Origin"

func readChangeOrigin(r *http.Request) string {
	origin := strings.TrimSpace(r.Header.Get(changeOriginHeader))
	if origin == "" {
		return ""
	}
	if len(origin) > 128 {
		origin = origin[:128]
	}
	return origin
}
