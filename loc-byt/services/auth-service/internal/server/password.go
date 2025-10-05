package server

import (
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/argon2"
)

// HashPassword returns an argon2id hash of the password with a random salt.
func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil { return "", err }
	h := argon2.IDKey([]byte(pw), salt, 1, 64*1024, 4, 32)
	return "argon2id$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(h), nil
}

// VerifyPassword compares a password with an argon2id hash.
func VerifyPassword(pw, hashed string) (bool, error) {
	const prefix = "argon2id$"
	if len(hashed) == 0 || len(pw) == 0 { return false, errors.New("empty") }
	if len(hashed) < len(prefix) || hashed[:len(prefix)] != prefix { return false, errors.New("unsupported") }
	parts := hashed[len(prefix):]
	sep := -1
	for i := 0; i < len(parts); i++ { if parts[i] == '$' { sep = i; break } }
	if sep <= 0 { return false, errors.New("invalid format") }
	saltB, err := base64.RawStdEncoding.DecodeString(parts[:sep]); if err != nil { return false, err }
	expB, err := base64.RawStdEncoding.DecodeString(parts[sep+1:]); if err != nil { return false, err }
	calc := argon2.IDKey([]byte(pw), saltB, 1, 64*1024, 4, 32)
	if len(calc) != len(expB) { return false, nil }
	eq := true
	for i := range calc { if calc[i] != expB[i] { eq = false } }
	return eq, nil
}

