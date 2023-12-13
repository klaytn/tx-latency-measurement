# syntax=docker/dockerfile:1

FROM golang:1.21.4

# Set destination for COPY
WORKDIR /app

# Download Go modules
ADD . /app
RUN go mod download

# Copy the source code. Note the slash at the end, as explained in
# https://docs.docker.com/engine/reference/builder/#copy

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o /go-finalityscraper

# Run
CMD ["/go-finalityscraper"]