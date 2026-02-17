package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/bytedance/gopkg/util/logger"
	"github.com/google/uuid"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"

	_ "github.com/lib/pq"
)

var (
	cognitoAuthConfig              *CognitoAuthConfig
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

type ctxKey string

const TraceIDKey ctxKey = "trace_id"

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

// AuthConfig represents the data your frontend needs
type CognitoAuthConfig struct {
	ClientID    string `json:"clientId"`
	Domain      string `json:"domain"`
	RedirectURI string `json:"redirectUri"`
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
	cognitoAuthConfig = &CognitoAuthConfig{
		ClientID:    os.Getenv("COGNITO_CLIENT_ID"),
		Domain:      os.Getenv("COGNITO_DOMAIN"),
		RedirectURI: os.Getenv("COGNITO_REDIRECT_URI"),
	}

	region = os.Getenv("AWS_REGION")
	userPoolID := os.Getenv("COGNITO_USER_POOL_ID")
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

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Initialize ServeMux (Standard Library Router)
	mux := http.NewServeMux()

	// Public Routes
	mux.HandleFunc("GET /api/v1/health", getHealth)
	mux.HandleFunc("GET /api/v1/info", getCognitoAuthConfig)

	// Protected Routes
	// Wrap the specific handlers with our AuthMiddleware
	mux.Handle("GET /api/v1/books", AuthMiddleware(http.HandlerFunc(getBooks)))
	mux.Handle("GET /api/v1/ai/prompt", AuthMiddleware(http.HandlerFunc(askPrompt)))
	mux.Handle("GET /api/v1/upload/token", AuthMiddleware(http.HandlerFunc(getSTSEndpoint)))
	mux.Handle("GET /api/v1/user/profile", AuthMiddleware(http.HandlerFunc(getUserProfile)))

	var handler http.Handler = mux
	handler = TracingMiddleware(handler) // Use the wrapped handler

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      handler,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go startSQSPoller(ctx)

	go func() {
		log.Printf("Server starting on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %s\n", err)
		}
	}()

	<-ctx.Done()
	log.Println("Shutting down gracefully...")

	shutdownCtx, srvCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer srvCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Fatal("Server forced to shutdown:", err)
	}
	log.Println("Server exiting")
}

// --- Middleware ---

func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceID, _ := r.Context().Value(TraceIDKey).(string)

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authorization error"})
			return
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		keyset, err := jwksCache.Get(r.Context(), cognitoIssuer+"/.well-known/jwks.json")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to fetch keys", "ref": traceID})
			return
		}

		verifiedToken, err := jwt.ParseString(tokenStr,
			jwt.WithKeySet(keyset),
			jwt.WithValidate(true),
			jwt.WithIssuer(cognitoIssuer),
		)

		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid token: " + err.Error(), "ref": traceID})
			return
		}

		// Inject claims into request context
		email, _ := verifiedToken.Get("email")
		ctx := context.WithValue(r.Context(), "email", email)
		ctx = context.WithValue(ctx, "token", tokenStr)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func TracingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. Generate or catch existing Trace ID
		traceID := r.Header.Get("X-Trace-ID")
		if traceID == "" {
			traceID = uuid.New().String()
		}

		// 2. Put it in context
		ctx := context.WithValue(r.Context(), TraceIDKey, traceID)

		// 3. Set it in response header so the user/frontend sees it
		w.Header().Set("X-Trace-ID", traceID)

		// 4. Pass the new context to the next handler
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// --- Handlers ---

func getBooks(w http.ResponseWriter, r *http.Request) {
	books := []Book{
		{ID: "1", Title: "Test book 1", Author: "Test Golang"},
	}
	writeJSON(w, http.StatusOK, books)
}

func getUserProfile(w http.ResponseWriter, r *http.Request) {
	email := r.Context().Value("email")
	token := r.Context().Value("token")
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"email": email,
		"token": token,
	})
}

func getHealth(w http.ResponseWriter, r *http.Request) {
	traceID, _ := r.Context().Value(TraceIDKey).(string)

	err := db.Ping()
	if err != nil {
		logger.Error(fmt.Sprintf("%v: health check failure: %v", traceID, err.Error()))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error", "ref": traceID})
		return
	}
	writeJSON(w, http.StatusOK, Health{Health: 1})
}

func getCognitoAuthConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, cognitoAuthConfig)
}

func getSTSEndpoint(w http.ResponseWriter, r *http.Request) {
	traceID, _ := r.Context().Value(TraceIDKey).(string)

	prefix := fmt.Sprintf("%v/upload-%v", tenantId, uuid.New())

	// ... (Keep the policy string logic exactly the same)
	policy := fmt.Sprintf(`{...}`, s3TenantDataBucketName, prefix, tenantId, kmsTenantKeyArn)

	input := sts.GetFederationTokenInput{
		Name:            aws.String(fmt.Sprintf("Upload-%s", tenantId)),
		Policy:          aws.String(policy),
		DurationSeconds: aws.Int32(900),
	}

	result, err := stsClient.GetFederationToken(r.Context(), &input)
	if err != nil {
		logger.Error(fmt.Sprintf("%v: sts token generation failure: %v", traceID, err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "error token generation"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"access_key":    *result.Credentials.AccessKeyId,
		"secret_key":    *result.Credentials.SecretAccessKey,
		"session_token": *result.Credentials.SessionToken,
		"kms_key_id":    kmsTenantKeyArn,
		"sts_endpoint":  "https://sts.amazonaws.com",
		"required_tag":  fmt.Sprintf("tenantId=%s", tenantId),
	})
}

func askPrompt(w http.ResponseWriter, r *http.Request) {
	payload := AnthropicBody{
		AnthropicVersion: "bedrock-2023-05-31",
		MaxTokens:        1024,
		Messages: []Message{
			{Role: "user", Content: "Is google gemini winning over chatgpt?"},
		},
	}

	payloadBytes, _ := json.Marshal(payload)

	output, err := bedrockClient.InvokeModel(r.Context(), &bedrockruntime.InvokeModelInput{
		ModelId:     aws.String(bedrockModelId),
		ContentType: aws.String("application/json"),
		Body:        payloadBytes,
	})

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	var result map[string]interface{}
	json.Unmarshal(output.Body, &result)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":   "success",
		"response": result["content"],
	})
}

// --- Helpers ---
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
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
