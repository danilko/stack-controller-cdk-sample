package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"

	// Replace "go-swagger-api" with your actual module name from go.mod
	_ "api/docs"
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

// @title           Go Sample REST API
// @version         1.0
// @description     This is a sample server for a book management API.
// @host            localhost:8080
// @BasePath        /api/v1

func main() {
	r := gin.Default()

	v1 := r.Group("/api/v1")
	{
		v1.GET("/books", GetBooks)
		v1.GET("/health", GetHealth)
	}

	// Swagger route
	r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	r.Run("0.0.0.0:8080")
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
