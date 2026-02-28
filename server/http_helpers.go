package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dest any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodySize)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dest); err != nil {
		var synErr *json.SyntaxError
		if errors.As(err, &synErr) {
			return errors.New("invalid JSON body")
		}
		if errors.Is(err, io.EOF) {
			return errors.New("empty JSON body")
		}
		if strings.Contains(err.Error(), "http: request body too large") {
			return fmt.Errorf("request body exceeds %d bytes", maxJSONBodySize)
		}
		return errors.New("invalid JSON body")
	}

	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("invalid JSON body")
	}

	return nil
}

func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/client-api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
		http.NotFound(w, r)
		return
	}

	requested := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if requested == "." || requested == "" {
		http.ServeFile(w, r, filepath.Join(s.clientDir, "index.html"))
		return
	}

	absDist, err := filepath.Abs(s.clientDir)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	full := filepath.Join(absDist, requested)
	absFull, err := filepath.Abs(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	prefix := absDist + string(os.PathSeparator)
	if absFull != absDist && !strings.HasPrefix(absFull, prefix) {
		http.NotFound(w, r)
		return
	}

	if info, err := os.Stat(absFull); err == nil && !info.IsDir() {
		if ct := mime.TypeByExtension(filepath.Ext(absFull)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		http.ServeFile(w, r, absFull)
		return
	}

	http.ServeFile(w, r, filepath.Join(absDist, "index.html"))
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("failed to write JSON response: %v", err)
	}
}

func (s *Server) handleAPINotFound(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotFound, errors.New("endpoint not found"))
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func randomToken(numBytes int) (string, error) {
	buf := make([]byte, numBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
