package main

import (
	"context"
	"fmt"
	"github.com/bytedance/gopkg/util/logger"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
	"golang.org/x/oauth2"

	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	// Replace "go-swagger-api" with your actual module name from go.mod
	_ "api/docs"
)

var (
	cognitoConfig *oauth2.Config
	jwksCache     *jwk.Cache
	cognitoIssuer string
)

func init() {
	region := os.Getenv("AWS_REGION")
	userPoolID := os.Getenv("COGNITO_USER_POOL_ID")
	cognitoDomain := os.Getenv("COGNITO_DOMAIN")

	cognitoIssuer = fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/%s", region, userPoolID)
	jwksURL := cognitoIssuer + "/.well-known/jwks.json"

	cognitoConfig = &oauth2.Config{
		ClientID:     os.Getenv("COGNITO_CLIENT_ID"),
		ClientSecret: os.Getenv("COGNITO_CLIENT_SECRET"),
		RedirectURL:  "http://localhost:8080/callback",
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  cognitoDomain + "/oauth2/authorize",
			TokenURL: cognitoDomain + "/oauth2/token",
		},
	}

	logger.Info(fmt.Sprintf("Start Cognito Configuration against: %s", cognitoIssuer))

	// Setup JWKS cache to avoid fetching keys on every request
	jwksCache = jwk.NewCache(context.Background())
	jwksCache.Register(jwksURL, jwk.WithMinRefreshInterval(15*time.Minute))
}

// Book represents the data model
type Book struct {
	ID     string `json:"id" example:"1"`
	Title  string `json:"title" example:"The Go Programming Language"`
	Author string `json:"author" example:"Alan A. A. Donovan"`
}

type Health struct {
	Health int `json:"health" example:"1"`
}

// @title           Go Sample REST API
// @version         1.0
// @description     This is a sample server for a book management API.
// @host            localhost:8080
// @BasePath        /api/v1
func main() {
	r := gin.Default()

	r.GET("/login", func(c *gin.Context) {
		url := cognitoConfig.AuthCodeURL("state-token")
		c.Redirect(http.StatusTemporaryRedirect, url)
	})

	r.GET("/callback", HandleCallback)

	v1 := r.Group("/api/v1")
	{
		// 1. Public Routes
		// Keep health checks public so the ALB/ECS can verify the container is alive
		v1.GET("/health", GetHealth)

		// 2. Protected Routes
		// Create a sub-group that applies the middleware to everything inside the braces
		authorized := v1.Group("/")
		authorized.Use(AuthMiddleware())
		{
			authorized.GET("/books", GetBooks)
			authorized.GET("/user/profile", GetUserProfile)
			// Any route added here automatically requires a token
		}
	}
	// Swagger route
	r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	r.Run("0.0.0.0:8080")
}

func HandleCallback(c *gin.Context) {
	code := c.Query("code")
	token, err := cognitoConfig.Exchange(c.Request.Context(), code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Exchange failed"})
		return
	}
	// Return the token to the user (or set in a secure cookie)
	c.JSON(200, gin.H{"access_token": token.AccessToken, "id_token": token.Extra("id_token")})
}

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.AbortWithStatusJSON(401, gin.H{"error": "No token provided"})
			return
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		// Get Cognito Public Keys from cache
		keyset, err := jwksCache.Get(c.Request.Context(), cognitoIssuer+"/.well-known/jwks.json")
		if err != nil {
			c.AbortWithStatusJSON(500, gin.H{"error": "Failed to fetch keys"})
			return
		}

		// Parse and Verify the Token
		verifiedToken, err := jwt.ParseString(tokenStr,
			jwt.WithKeySet(keyset),
			jwt.WithValidate(true),
			jwt.WithIssuer(cognitoIssuer),
		)

		if err != nil {
			c.AbortWithStatusJSON(401, gin.H{"error": "Invalid token: " + err.Error()})
			return
		}

		// Optional: Store claims in Gin context for later use
		email, _ := verifiedToken.Get("email")
		c.Set("email", email)
		c.Set("token", tokenStr)

		c.Next()
	}
}

// GetBooks godoc
// @Summary      Show all books
// @Description  get all books currently in the database
// @Tags         books
// @Produce      json
// @Success      200  {array}   Book
// @Router       /books [get]
func GetBooks(c *gin.Context) {
	books := []Book{
		{ID: "1", Title: "Test book 1", Author: "Test Golang"},
	}
	c.JSON(http.StatusOK, books)
}

func GetUserProfile(c *gin.Context) {
	// Access user info stored in context by middleware
	email, _ := c.Get("email")
	token, _ := c.Get("token")
	c.JSON(200, gin.H{"email": email, "token": token})
}

// GetHealth godoc
// @Summary      Check health
// @Description  get if API is available
// @Tags         health
// @Produce      json
// @Success      200  obj Health
// @Router       /health [get]
func GetHealth(c *gin.Context) {
	health := Health{Health: 1}
	c.JSON(http.StatusOK, health)
}
