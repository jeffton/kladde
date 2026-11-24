package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJSONBodyLimitAppliesToTrailingWhitespace(t *testing.T) {
	for name, prefix := range map[string]string{"before value": "", "after value": "{}"} {
		t.Run(name, func(t *testing.T) {
			body := prefix + strings.Repeat(" ", maxJSONBodySize) + " "
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
			var payload struct{}
			err := decodeJSONBody(httptest.NewRecorder(), r, &payload)
			want := fmt.Sprintf("request body exceeds %d bytes", maxJSONBodySize)
			if err == nil || err.Error() != want {
				t.Fatalf("got %v, want %q", err, want)
			}
		})
	}
}

func TestAgentMarkdownBodyLimit(t *testing.T) {
	s, token, _ := makeAgentTestServer(t, false)
	req := authRequest(http.MethodPut, "/api/notes/large", token, strings.Repeat("x", maxMarkdownBodySize+1))
	w := httptest.NewRecorder()
	s.handleAgentNoteByPath(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got status %d, want 413: %s", w.Code, w.Body.String())
	}
}
