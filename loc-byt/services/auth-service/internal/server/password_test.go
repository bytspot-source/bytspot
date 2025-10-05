package server

import "testing"

func TestHashAndVerifyPassword(t *testing.T) {
	pw := "S3cure!Password"
	h, err := HashPassword(pw)
	if err != nil { t.Fatalf("hash error: %v", err) }
	if h == "" { t.Fatal("empty hash") }

	ok, err := VerifyPassword(pw, h)
	if err != nil { t.Fatalf("verify error: %v", err) }
	if !ok { t.Fatal("expected verify ok") }

	ok2, _ := VerifyPassword("wrong", h)
	if ok2 { t.Fatal("expected verify to fail with wrong pw") }
}

