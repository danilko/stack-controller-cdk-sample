package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/bytedance/gopkg/util/logger"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
	"golang.org/x/oauth2"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	_ "github.com/lib/pq"

	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	// Replace "go-swagger-api" with your actual module name from go.mod
	_ "api/docs"
)

var (
	cognitoConfig                  *oauth2.Config
	jwksCache                      *jwk.Cache
	cognitoIssuer                  string
	bedrockClient                  *bedrockruntime.Client
	s3Client                       *s3.Client
	sqsClient                      *sqs.Client
	stsClient                      *sts.Client
	bedrockModelId                 string
	s3ShareServiceIngestBucketName string
	s3TenantDataBucketName         string
	sqsTenantIngestS3QueueURL      string
	db                             *sql.DB
	region                         string
	kmsTenantKeyArn                string
	tenantId                       string
)

// Book represents the data model
type Book struct {
	ID     string `json:"id" example:"1"`
	Title  string `json:"title" example:"The Go Programming Language"`
	Author string `json:"author" example:"Alan A. A. Donovan"`
}

type Health struct {
	Health int `json:"health" example:"1"`
}

// Request body structure
type PromptRequest struct {
	Prompt string `json:"prompt" binding:"required"`
}

// Anthropic specific structures
type AnthropicBody struct {
	AnthropicVersion string    `json:"anthropic_version"`
	MaxTokens        int       `json:"max_tokens"`
	Messages         []Message `json:"messages"`
}

type GuardDutyEvent struct {
	Detail struct {
		ScanStatus      string `json:"scanStatus"` // e.g., NO_THREATS_FOUND
		ResourceDetails struct {
			ResourceType string `json:"resourceType"`
		} `json:"resourceType"`
		S3ObjectDetails struct {
			BucketName string `json:"bucketName"`
			Key        string `json:"key"` // THIS IS THE FULL PATH
		} `json:"s3ObjectDetails"`
	} `json:"detail"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func init() {
	region = os.Getenv("AWS_REGION")
	userPoolID := os.Getenv("COGNITO_USER_POOL_ID")
	cognitoDomain := os.Getenv("COGNITO_DOMAIN")
	tenantId = os.Getenv("TENANT_ID")
	kmsTenantKeyArn = os.Getenv("KMS_TENANT_KEY_ARN")

	s3ShareServiceIngestBucketName = os.Getenv("S3_SHARE_SERVICE_INGEST_BUCKET_NAME")
	s3TenantDataBucketName = os.Getenv("S3_TENANT_DATA_BUCKET_NAME")
	sqsTenantIngestS3QueueURL = os.Getenv("SQS_TENANT_INGEST_S3_QUEUE_URL")

	bedrockModelId = os.Getenv("BEDROCK_MODEL_ID")
	// Initialize AWS Config once at startup
	cfg, err := config.LoadDefaultConfig(context.TODO(), config.WithRegion(region))
	if err != nil {
		panic("unable to load SDK config")
	}
	bedrockClient = bedrockruntime.NewFromConfig(cfg)
	s3Client = s3.NewFromConfig(cfg)
	sqsClient = sqs.NewFromConfig(cfg)
	stsClient = sts.NewFromConfig(cfg)

	cognitoIssuer = fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/%s", region, userPoolID)
	jwksURL := cognitoIssuer + "/.well-known/jwks.json"

	cognitoConfig = &oauth2.Config{
		ClientID:     os.Getenv("COGNITO_CLIENT_ID"),
		ClientSecret: os.Getenv("COGNITO_CLIENT_SECRET"),
		RedirectURL:  os.Getenv("COGNITO_REDIRECT_URL"),
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

	initDBConnection()
}

func initDBConnection() {
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	user := os.Getenv("DB_USER")
	pass := os.Getenv("DB_PASSWORD")
	dbname := os.Getenv("DB_NAME")

	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, pass, dbname)

	localDb, err := sql.Open("postgres", dsn)
	if err != nil {
		panic(err)
	}
	// Assign to global context once complete init
	db = localDb
}

// @title           Go Sample REST API
// @version         1.0
// @description     This is a sample server for a book management API.
// @host            localhost:8080
// @BasePath        /api/v1
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

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
			authorized.GET("/ai/prompt", AskPrompt)

			authorized.GET("/upload/token", getSTSEndpoint)

			authorized.GET("/user/profile", GetUserProfile)
			// Any route added here automatically requires a token
		}
	}
	// Swagger route
	r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	srv := &http.Server{
		Addr:    ":8080",
		Handler: r,
	}

	// Start SQS Poller in a separate Goroutine
	go startSQSPoller(ctx)

	// Start Server in a separate Goroutine
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %s\n", err)
		}
	}()

	// Wait for ECS/manual user to send a SIGTERM (shutdown signal)
	<-ctx.Done()
	log.Println("Shutting down gracefully...")

	// Tell the HTTP server to stop accepting new requests
	// Give it 5 seconds to finish current requests
	shutdownCtx, srvCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer srvCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Fatal("Server forced to shutdown:", err)
	}

	log.Println("Server exiting")
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
	err := db.Ping()
	if err != nil {
		c.String(http.StatusInternalServerError, "DB Error: %s", err)
		return
	}

	health := Health{Health: 1}
	c.JSON(http.StatusOK, health)
}

func startSQSPoller(c context.Context) {
	for {
		select {
		case <-c.Done():
			log.Println("Stopping SQS Poller...")
			return
		default:
			// By passing 'ctx' here, if ECS stops the task,
			// the AWS SDK will cancel the inflight SQS request immediately.
			processMessages(c)
			// sleep to wait fo next pull
			time.Sleep(5 * time.Second)
		}
	}
}

func processMessages(c context.Context) {
	log.Println("Polling SQS...")

	// 1. Receive Message (Long Polling)
	output, err := sqsClient.ReceiveMessage(c, &sqs.ReceiveMessageInput{
		QueueUrl:            aws.String(sqsTenantIngestS3QueueURL),
		MaxNumberOfMessages: 10,
		WaitTimeSeconds:     20, // Reduces empty responses/costs
	})

	if err != nil {
		log.Printf("Failed to fetch SQS: %v", err)
		return
	}

	for _, msg := range output.Messages {
		var event GuardDutyEvent
		if err := json.Unmarshal([]byte(*msg.Body), &event); err != nil {
			log.Printf("Error unmarshaling: %v", err)
			continue
		}

		// Extract Key and Bucket
		key := event.Detail.S3ObjectDetails.Key
		bucket := event.Detail.S3ObjectDetails.BucketName
		status := event.Detail.ScanStatus

		// 2. Logic: Process only if bucket and prefix matches and scan is clean
		if strings.EqualFold(bucket, s3ShareServiceIngestBucketName) &&
			strings.HasPrefix(key, "tenant-a/") {
			if status == "NO_THREATS_FOUND" {
				handleSafeObject(c, s3Client, key)
			} else {
				handleUnsafeObject(c, s3Client, key)
			}
		} else {
			log.Printf("Receive non related message from bucket: %v and key: %v", bucket, key)
		}

		// 3. Delete message from SQS after processing
		_, err := sqsClient.DeleteMessage(c, &sqs.DeleteMessageInput{
			QueueUrl:      aws.String(sqsTenantIngestS3QueueURL),
			ReceiptHandle: msg.ReceiptHandle,
		})
		if err != nil {
			log.Printf("Error delete message: %v", err)
			return
		}
	}
}

func handleSafeObject(ctx context.Context, s3Client *s3.Client, key string) {
	destBucket := s3TenantDataBucketName
	copySource := fmt.Sprintf("%s/%s", s3ShareServiceIngestBucketName, key)

	// Copy to new bucket
	_, err := s3Client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(destBucket),
		CopySource: aws.String(copySource),
		Key:        aws.String(key),
	})
	if err != nil {
		log.Printf("Copy failed: %v", err)
		return
	}

	// Delete from original (landing) bucket
	_, err = s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s3ShareServiceIngestBucketName),
		Key:    aws.String(key),
	})
	if err != nil {
		log.Printf("Delete failed: %v", err)
	}
}

func handleUnsafeObject(ctx context.Context, s3Client *s3.Client, key string) {
	log.Printf("Delete unsafe object from bucket: %v and key: %v", s3ShareServiceIngestBucketName, key)

	// Delete from original (landing) bucket
	_, err := s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s3ShareServiceIngestBucketName),
		Key:    aws.String(key),
	})
	if err != nil {
		log.Printf("Delete failed: %v", err)
	}
}

func getSTSEndpoint(c *gin.Context) {
	prefix := fmt.Sprintf("%v/upload-%v", tenantId, rand.Int())

	// This policy is the "filter". Even if the ECS role has full S3 access,
	// this token will ONLY have these specific rights.
	policy := fmt.Sprintf(`{
			"Version": "2012-10-17",
			"Statement": [
				{
					"Effect": "Allow",
					"Action": "s3:PutObject",
					"Resource": "arn:aws:s3:::%s/%s",
					"Condition": {
						"StringEquals": { "s3:RequestObjectTag/tenantId": "%s" }
					}
				},
				{
					"Effect": "Allow",
					"Action": [
					"kms:GenerateDataKey",
                    "kms:Decrypt",
					"kms:DescribeKey"
					],
					"Resource": "%s"
				}
			]
		}`, s3TenantDataBucketName, prefix, tenantId, kmsTenantKeyArn)

	input := sts.GetFederationTokenInput{
		Name:   aws.String(fmt.Sprintf("Upload-%s", tenantId)),
		Policy: aws.String(policy),
		// Only allow 15 minutes to reduce security risk
		DurationSeconds: aws.Int32(900),
	}

	result, err := stsClient.GetFederationToken(c, &input)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"access_key":    *result.Credentials.AccessKeyId,
		"secret_key":    *result.Credentials.SecretAccessKey,
		"session_token": *result.Credentials.SessionToken,
		"kms_key_id":    kmsTenantKeyArn,
		"sts_endpoint":  "https://sts.amazonaws.com", // Or regional endpoint
		"required_tag":  fmt.Sprintf("tenantId=%s", tenantId),
	})
}

func AskPrompt(c *gin.Context) {
	//var req PromptRequest
	//if err := c.ShouldBindJSON(&req); err != nil {
	//	c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
	//	return
	//}

	// Prepare Anthropic Payload
	payload := AnthropicBody{
		AnthropicVersion: "bedrock-2023-05-31",
		MaxTokens:        1024,
		Messages: []Message{
			{Role: "user", Content: "Is google gemini winning over chatgpt?"},
		},
	}

	payloadBytes, _ := json.Marshal(payload)

	// Invoke Bedrock
	output, err := bedrockClient.InvokeModel(context.TODO(), &bedrockruntime.InvokeModelInput{
		ModelId:     aws.String(bedrockModelId),
		ContentType: aws.String("application/json"),
		Body:        payloadBytes,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Parse Response (Simplified for this example)
	var result map[string]interface{}
	json.Unmarshal(output.Body, &result)

	c.JSON(http.StatusOK, gin.H{
		"status":   "success",
		"response": result["content"],
	})
}
