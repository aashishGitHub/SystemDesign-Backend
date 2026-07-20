# Messaging: REST, gRPC, GraphQL, AMQP, Kafka & AWS

> Study notes covering synchronous/asynchronous communication patterns,  
> core protocols, and cloud-native messaging services on AWS.

---

## Table of Contents

1. [Synchronous vs Asynchronous Communication](#1-synchronous-vs-asynchronous-communication)
2. [HTTP Fundamentals](#2-http-fundamentals)
3. [REST (Representational State Transfer)](#3-rest-representational-state-transfer)
4. [gRPC (Google Remote Procedure Call)](#4-grpc-google-remote-procedure-call)
5. [GraphQL](#5-graphql)
6. [AMQP & RabbitMQ](#6-amqp--rabbitmq)
7. [Event Sourcing](#7-event-sourcing)
8. [Apache Kafka](#8-apache-kafka)
9. [Data Streaming](#9-data-streaming)
10. [AWS Messaging Services](#10-aws-messaging-services)
11. [WebSockets](#11-websockets)
12. [Asynchronous Messaging: Problems & Solutions](#12-asynchronous-messaging-problems--solutions)

---

## 1. Synchronous vs Asynchronous Communication

### Synchronous Communication

- Requires **both sender and receiver to be active simultaneously**
- Sender **waits for response**, creating tight coupling
- Both remain active during the full communication lifecycle
- If receiver is inactive, communication is discontinued
- Mostly built around **HTTP/HTTPS** (client/server)
- **Example:** REST API calls, phone calls

### Asynchronous Communication

- Sender and receiver interact **independently**
- Messages are **stored in a queue/broker** until the receiver is ready
- No prompt response expected — like email/messaging
- Best for **decoupling services and components**
- **Example:** AMQP, Kafka

---

## 2. HTTP Fundamentals

### Overview

- Foundation of the web — **Application Layer Protocol**
- Loads webpages using hypertext links
- URI identifies a resource on the server

### Parts of a URI

| Part | Description |
|------|-------------|
| Scheme | Indicates the protocol (e.g., `http`, `https`) |
| Host | Server's domain or IP address |
| Path | Points to a specific resource |
| Query String | Contains parameters for requests |

### HTTP Methods

| Method | Purpose | Example |
|--------|---------|---------|
| `GET` | Retrieve data | `GET /products` |
| `POST` | Create new resources | `POST /products` |
| `PUT` | Update/create a resource | `PUT /products/1` |
| `DELETE` | Remove a resource | `DELETE /products/1` |
| `PATCH` | Partially update a resource | `PATCH /products/1` |
| `HEAD` | Retrieve headers only (no body) | `HEAD /products` |
| `OPTIONS` | Describe communication options | `OPTIONS /products` |

### HTTP Request Headers

| Header | Purpose | Example |
|--------|---------|---------|
| `Content-Type` | Media type of the data being sent | `application/json` |
| `Accept` | Media types the client can process | `application/json` |
| `Authorization` | Client authentication credentials | `Bearer token123` |
| `Cache-Control` | Caching directives | `no-cache, no-store` |
| `User-Agent` | Requesting agent info | `Mozilla/5.0` |
| `Host` | Server domain and port | `www.example.com` |
| `Connection` | Keep connection alive | `keep-alive` |
| `Content-Length` | Body size in bytes | `348` |
| `Cookie` | Stored HTTP cookies | `sessionId=abc123` |

### Payload and Parameters

- **Payload (Body):** Data sent in `POST`, `PUT`, `PATCH` requests — not part of the URI
- **Path Parameters:** Part of the URI path, identifies specific resources (e.g., `/products/123`)
- **Query Parameters:** Passed in the URI query string, filters/modifies the request (e.g., `/products?category=electronics`)

### HTTP Response Headers

| Header | Purpose | Example |
|--------|---------|---------|
| `Content-Type` | Media type of the response body | `application/json` |
| `Content-Length` | Body size in bytes | `348` |
| `Set-Cookie` | Sends cookies from server to client | `sessionId=abc123; Path=/; Secure; HttpOnly` |
| `Location` | URL for redirecting | `https://www.example.com/newpage` |

### HTTP Version Comparison

#### HTTP/2 (Released 2015)
- **Purpose:** Improve performance and efficiency over HTTP/1.1
- **Features:**
  - Binary Protocol (instead of text-based)
  - Multiplexing — multiple requests over a single connection
  - Header Compression
  - Stream Prioritization
  - **Server Push** — server can proactively send resources to the client

#### HTTP/3
- Based on **QUIC** — a Transport Layer Network Protocol developed by Google
- **Advantages:**
  - Better performance (solves HTTP/2 head-of-line blocking)
  - Improved multiplexing at the transport layer
  - Enhanced security
  - Improved reliability over unreliable networks

---

## 3. REST (Representational State Transfer)

### What is REST?

- An **architectural style**, not a protocol
- Uses HTTP protocol
- Sends/receives data in simple text formats like **JSON or XML**
- Resources are individual pieces of data managed via HTTP methods
- Implemented independently (client and server are decoupled)
- REST APIs originated from **RPC** concepts

### REST Key Features

| Feature | Description |
|---------|-------------|
| **Stateless** | Server stores no information about requests; client stores necessary state (often using cache) |
| **Cacheable** | Resources can be cached — server indicates via `Cache-Control`, `Expires`, `ETag` headers |
| **Client-Server Independence** | Client and server evolve independently |

**Caching Example:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: public, max-age=3600
ETag: abc123
```

### REST Development Considerations

**URI Design:**
- Use **nouns**, avoid verbs in URIs
- `/users` for a collection, `/users/123` for a specific resource
- Consistent and meaningful URIs

**HTTP Methods:**
- Use `GET` to retrieve, `POST` to create, `PUT`/`PATCH` to update, `DELETE` to remove

**Other Considerations:**
- Statelessness
- Versioning (e.g., `/v1/users`)
- Error handling with proper HTTP status codes
- Security: use HTTPS, authentication/authorization, input validation & sanitization
- Pagination, filtering, and sorting for large datasets
- Rate limiting and throttling
- Documentation (e.g., OpenAPI/Swagger)

---

## 4. gRPC (Google Remote Procedure Call)

### Introduction

- Open-source **RPC Framework** developed by Google
- Evolved concept of RPC — allows calling methods on a remote system as if local
- Utilizes **HTTP/2** (multiplexing, binary framing, stream prioritization)
- Uses **Protocol Buffers (protobuf)** for serialization
- Strong authentication and encryption mechanisms

### gRPC Streaming Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Unary** | Single request → single response | Standard request/response |
| **Server Streaming** | Single request → multiple streamed responses | Server sends data over time |
| **Client Streaming** | Multiple requests → single response | Uploading chunks of a large file |
| **Bidirectional Streaming** | Both client & server send streams independently | Real-time chat, live video streaming |

### Protocol Buffers (Protobuf)

**Features:**
- **Language-agnostic** — supports C++, Java, Python, Go, Ruby, C#
- **Efficient serialization** — encodes into compact binary format
- Smaller and faster to parse than JSON
- Data structures defined in `.proto` files

**Working with Protobuf:**
1. Define messages (data structures) and services (RPC methods) in a `.proto` file
2. Use `protoc` (Protobuf Compiler) to generate client & server code
3. Integrate code generation into the build process

### gRPC Status Codes

| Code | Description |
|------|-------------|
| `OK` | Successful |
| `CANCELLED` | Operation cancelled by caller |
| `UNKNOWN` | Unknown error |
| `INVALID_ARGUMENT` | Client specified invalid argument |
| `DEADLINE_EXCEEDED` | Deadline expired before operation complete |
| `NOT_FOUND` | Requested entity not found |
| `ALREADY_EXISTS` | Entity trying to create already exists |
| `PERMISSION_DENIED` | Caller does not have permission |
| `RESOURCE_EXHAUSTED` | Resource has been exhausted |
| `FAILED_PRECONDITION` | Operation was rejected |
| `ABORTED` | Operation was aborted |
| `OUT_OF_RANGE` | Out of range |
| `UNIMPLEMENTED` | Operation not implemented |
| `INTERNAL` | Internal errors |
| `UNAVAILABLE` | Service unavailable |
| `DATA_LOSS` | Unrecoverable data loss |
| `UNAUTHENTICATED` | Not a valid authentication |

### gRPC vs REST

**Similarities:**
- Both follow a client-server model
- Both rely on network protocols (HTTP/1.1, HTTP/2)
- Implemented across various programming languages
- Both JSON and Protobuf are platform-independent

**Differences:**

| Aspect | gRPC | REST |
|--------|------|------|
| Performance | High performance, open-source framework | Text-based, simpler |
| Interface Definition | Defined using Protobuf (`.proto` files) | No formal interface definition |
| Data Format | Binary (Protobuf) — faster serialization | JSON/XML — slower than Protobuf |

### gRPC Development Considerations

- Define services and methods clearly in `.proto` files
- Choose appropriate data types for fields
- Avoid optional fields unless necessary (for compatibility)
- Assign **unique field numbers** in Protobuf — never reuse them
- Use standard gRPC status codes
- Design APIs for **backward compatibility**
- Use TLS for encryption
- Implement authentication with OAuth, JWT, or mTLS
- Enforce policies using gRPC **interceptors**
- Design services around **Single Responsibility Principle**

### gRPC Deployment on AWS

| Option | Notes |
|--------|-------|
| **AWS Lambda + API Gateway** | Limited direct gRPC support; API Gateway primarily handles REST/HTTP APIs |
| **Amazon EC2** | Full control over deployment |
| **AWS Fargate + ECS** | Fully supports gRPC via Docker containers running gRPC servers |
| **Application Load Balancer (ALB)** | Supports end-to-end HTTP/2 and gRPC |

---

## 5. GraphQL

### Overview

- A **query language for APIs** and a runtime for executing queries
- More flexible and efficient alternative to REST
- Allows clients to **request exactly the data needed** (reduces over-fetching and under-fetching)
- **Strongly typed schema**
- Supports **subscriptions for real-time updates**

**Disadvantages:**
- Complex queries can generate large query strings
- Increased server processing time for complex queries

### Core Components

| Component | Description | REST Analogy |
|-----------|-------------|--------------|
| **Queries** | Read/fetch data | `GET` requests |
| **Mutations** | Modify data | `POST`, `PUT`, `DELETE` |
| **Subscriptions** | Listen for real-time updates — server pushes updates to client | WebSocket-like |

### Key Concepts

- **Fields:** Represent data to be fetched or modified
- **Resolvers:** Functions for fetching a particular field in a type (Query, Mutation, Subscription resolvers)
- **Fragments:** Allow reuse of parts of GraphQL queries — helps organize and reuse query logic

### Tools for Building GraphQL APIs

| Tool | Description |
|------|-------------|
| **Apollo** | Includes both client and server libraries for building GraphQL APIs |
| **AWS AppSync** | Managed service; handles data fetching, caching, real-time updates, offline functionality; integrates with DynamoDB, Lambda, Cognito |
| **Relay** | JavaScript framework by Facebook for React + GraphQL; focuses on performance with query batching and caching |
| **Prisma** | Open-source ORM for TypeScript/JavaScript; simplifies DB access, automates CRUD with GraphQL |
| **Hasura** | Open-source engine for auto-generating GraphQL from PostgreSQL; supports real-time subscriptions and strong access control |

### Development Considerations

- Schema Design
- Performance optimization
- Error handling
- Security
- State management on the client side
- Tooling and monitoring
- Subscription and real-time data management

---

## 6. AMQP & RabbitMQ

### AMQP (Advanced Message Queuing Protocol)

- **Open standard protocol** for message-oriented middleware
- Inherently supports **asynchronous messaging**
- Scalable messaging for distributed systems
- Producers and Consumers model
- Supports:
  - Message Queuing
  - Routing (Point-to-Point and Publish-Subscribe)
- Implemented by message brokers like **RabbitMQ**

### AMQP Components

| Component | Role |
|-----------|------|
| **Publishers** | Send messages to be consumed |
| **Consumers** | Receive messages from queues (subscribed or on-demand) |
| **Broker** | Manages exchanges and queues; routes messages between publishers and consumers |

### Queues in AMQP

- Store messages until consumed — act as **buffers** that decouple producers from consumers
- Provide: Reliability, Scalability, Flexibility
- **Queue Properties:**
  - Name, Durable, Auto-Delete
  - TTL (Time-To-Live)
  - Dead Letter Exchanges (DLX)
  - Exclusive

### Exchange Types

| Type | Routing Behavior |
|------|-----------------|
| **Direct Exchange** | Routes on exact match between message routing key and queue binding key |
| **Fanout Exchange** | Routes to ALL bound queues, regardless of routing key |
| **Topic Exchange** | Routes on pattern matching; supports wildcards (`*`) |
| **Headers Exchange** | Routes based on matching header attributes instead of routing key; supports `all` or `any` matching |

### Bindings

- Define rules for how messages are routed from an exchange to a queue
- Use **binding keys** and routing patterns
- **Binding Key** — a pattern/value used by some exchange types (direct, topic) to determine routing
- **Routing Key** — attribute assigned by the publisher; used by the exchange to decide routing
- **Binding Arguments** — additional parameters used with Headers Exchanges

### Channels

- A **virtual connection** inside a physical TCP connection to an AMQP broker
- Key concepts: Lightweight, Concurrency, Isolation, Flow Control, Transactional Messaging

---

### RabbitMQ

Used by millions of developers; supports:
- Point-to-Point
- Publish/Subscribe
- Request/Reply
- Topic-based routing via exchanges
- Idempotent Consumer Pattern
- Streaming (Queues and Streams)

#### Messaging Design

1. Messages sent to **Exchanges**
2. Exchange routes messages to appropriate **Queues** based on type and binding rules
3. Enables messaging patterns: Direct, Topic-based routing, Pub/Sub

#### RabbitMQ Components

| Component | Role |
|-----------|------|
| **Broker** | Central node — receives, stores, forwards messages |
| **Exchanges** | Route messages to queues based on defined rules |
| **Queues** | Hold messages until consumed |
| **Producers** | Publish messages to exchanges |
| **Consumers** | Subscribe to queues and consume messages |

#### Queue Features

- **Fair Dispatch** — distributes tasks evenly among workers
- **Message Acknowledgment** — confirms message was processed
- **Classic Queue** — standard queue
- **Quorum Queue** — replicated, highly available queue
- **Durable Queues and Messages** — survive broker restarts

#### Streams vs Queues

| Use Case | Best Choice |
|----------|-------------|
| Simple message buffering | Queues |
| Point-to-point communication | Queues |
| Request-response patterns | Queues |
| Large fan-outs | Streams |
| High throughput performance | Streams |
| Event sourcing | Streams |

**RabbitMQ Streams:**
- **Append-only log** data structure
- Messages can be read repeatedly until they expire (unlike queues)
- Durable and replicated
- Consumers subscribe to the stream to read

---

## 7. Event Sourcing

### Overview

- A **system design pattern**
- Every change to state is **recorded as an event** instead of just updating data
- Events are stored sequentially, building a **complete history**

### Components

| Component | Description |
|-----------|-------------|
| **Event Store** | Database/storage of all events |
| **Events** | Represents a specific change |
| **Command** | Requested action that triggers an event |
| **Projection** | Reads a sequence of events to derive current state |
| **Aggregate** | Represents a cluster of related objects |

---

## 8. Apache Kafka

### Introduction

- **Distributed streaming platform** for real-time data processing
- Excellent choice for event sourcing and event-driven architectures

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Messages (Records)** | The unit of data in Kafka |
| **Producers** | Publish messages to Kafka topics; can specify partition per message |
| **Consumers** | Read messages from topics; subscribe and process messages |
| **Consumer Groups** | Group of consumers coordinating to consume from partitions; enables load balancing and parallel processing |
| **Topics** | Logical channel for storing and publishing records; partitioned for parallel processing and scalability |
| **Partitioning** | Divides topics for parallel processing; distributes load across brokers |
| **Replication** | Partitions replicated for high availability; leader handles read/write, followers replicate data |

### Messaging Features

- **Pub/Sub Messaging** with Consumer Groups
- **High Throughput**, Scalability, Durability, Low Latency
- Backpressure Handling
- Message Delivery Guarantees
- Message Ordering
- **Integration Ecosystem:** Kafka Connect, Kafka Streams, KSQL

### Kafka for Event Sourcing

Kafka is an excellent choice for event sourcing because it:
- Supports strong consistency guarantees
- Maintains correct state via ordered event processing
- Enables complex event processing
- Has a distributed architecture with data distributed across nodes
- Provides a reliable foundation for event-driven architectures

---

## 9. Data Streaming

### Core Concepts

- Continuous flow of data generated by sources, processed/stored/analyzed in **real time**
- **Real-Time Processing**

### Popular Technologies

**Stream Processing Frameworks:**
- Apache Kafka Streams
- Apache Spark Streaming

**Message Brokers for Streaming:**
- Apache Kafka
- RabbitMQ
- Amazon Kinesis

### AWS Kinesis

- **Fully managed** streaming data service by AWS
- Enables real-time data collection, processing, and analysis
- **Components:**
  - Kinesis Streams
  - Kinesis Firehose
  - Kinesis Analytics

#### AWS Kinesis vs Apache Kafka

| Aspect | Notes |
|--------|-------|
| Flexibility | Kafka is more flexible and open |
| Ecosystem Integration | Kinesis integrates natively with AWS services |
| Use Cases | Kinesis for AWS-centric pipelines; Kafka for multi-cloud/open deployments |

---

## 10. AWS Messaging Services

### Amazon SQS (Simple Queue Service)

- **Fully managed** message queuing service
- Message queuing and asynchronous processing
- Automatic scalability and reliability
- Ideal for decoupling and scaling distributed systems, serverless apps, microservices
- Supports **message retention**

#### Queue Types

| Feature | Standard Queues | FIFO Queues |
|---------|-----------------|-------------|
| Message Order | Best-effort (no guarantee) | Strict ordering, guaranteed |
| Duplicates | Possible — apps must handle | Exactly-once processing, no duplicates |
| Throughput | Unlimited | Limited (increased with high-throughput mode) |
| Use Cases | Background tasks, batch jobs | E-commerce orders, event processing, ticketing |
| Redundancy | Multi-AZ | Multi-AZ |
| Scalability | Highly scalable | Scalable with throughput limitations |

**Dead-Letter Queues (DLQ)** are also supported for failed message handling.

#### Standard Queue Use Cases

- **Background Task Processing:** Offloading image processing to a background worker (high throughput, decoupling)
- **Batch Jobs:** Collecting and aggregating log data from multiple servers

#### FIFO Queue Use Cases

- **Order Processing in E-Commerce:** Ensure orders processed in exact order placed (inventory management, customer satisfaction)
- **Financial Transactions:** Processing bank transactions where operation order is critical (exactly-once processing)

---

### Amazon SNS (Simple Notification Service)

- Manages message delivery from **publishers to subscribers**
- **Publish-Subscribe Model** — Topic-Based
- Enables sending notifications and alerts

**Key Features:**
- Message Delivery and Filtering
- Fan-Out Scenarios
- Reliability and Scalability
- **SNS FIFO Topics** — for ordered, deduplicated pub/sub

#### System-to-System Messaging

| Type | Description |
|------|-------------|
| **A2A (Application-to-Application)** | Decouples microservices; supports SQS, HTTP/S, Lambda, SMS, Email, Mobile Push |
| **A2P (Application-to-Person)** | Sends notifications directly to end users; supports SMS, Email, Mobile Push |

#### SNS FIFO Example

- **Scenario:** AWS Lambda publishes price updates to an SNS FIFO Topic (triggered by currency fluctuations, market demand)
- **Integration:** Backend subscribes to SNS FIFO Topic using an SQS FIFO Queue for ordered price updates

---

### Amazon EventBridge

- **Serverless Event Bus Service**
- Simplifies connecting applications using data from events
- Facilitates event-driven architectures
- Automatically responds to changes

**Data Sources:** Your applications, SaaS apps, AWS services

**Use Cases:** Microservices communication, event-driven applications, SaaS integration

#### Event Bus

- Central component for receiving and routing events
- Decouples event producers from consumers

**Event Bus Types:**

| Type | Description |
|------|-------------|
| Default Event Bus | Receives events from AWS services |
| Custom Event Bus | For your own application events |
| Partner Event Bus | For SaaS partner event sources |

**Key Components:** Rules, Targets

#### Amazon EventBridge vs Amazon SQS

| Feature | Amazon SQS | Amazon EventBridge |
|---------|-----------|-------------------|
| Purpose | Reliable message queuing | Event-driven architectures |
| Best Suited For | Point-to-point communication | Sophisticated event routing |
| Message Processing | FIFO and Standard | Event-driven, rules-based |
| Event Filtering | No built-in filtering | Rules-based with event patterns |

---

### Other Asynchronous Messaging Technologies

| Technology | Description |
|-----------|-------------|
| **JMS** | Java-based messaging; supports queues and topics |
| **AMQP** | Platform-independent protocol; extensive features (multiple exchange types, transactions) |
| **MQTT** | For low-power devices with minimal memory; IoT applications |

#### Messaging System Categories

| Category | Implementations |
|----------|----------------|
| **AMQP-Based** | Apache Qpid, Apache ActiveMQ, RabbitMQ |
| **Kafka-Based** | Apache Kafka, Amazon MSK (Managed Streaming for Apache Kafka) |
| **Cloud-Native** | Amazon SQS, Amazon SNS |

---

## 11. WebSockets

### Overview

- **Full-duplex communication protocol** over a persistent TCP connection
- How it works:
  1. **Handshake** — upgrade from HTTP to WebSocket
  2. **Data Frames** — data exchanged in frames
  3. **Connection remains open** for the duration of the session

**Key Points:** Full-Duplex, Persistent Connection, Real-Time Communication

**Use Cases:** Chat applications, online gaming, live collaboration tools

### WebSockets vs Apache Kafka

| Aspect | WebSockets | Apache Kafka |
|--------|-----------|--------------|
| Communication Model | Full-duplex, client-server | Publish-Subscribe, asynchronous |
| Scalability | Limited scalability, stateful connections | Highly scalable, distributed architecture |
| Message Persistence | Transient — no built-in storage | Persistent — retention policies |
| Protocol | Single TCP connection, real-time | Binary protocol, distributed system |
| Latency & Throughput | Low latency, moderate throughput | Variable latency, high throughput |
| Use Cases | Real-time apps, interactive UIs | Data streaming, event-driven systems |

---

## 12. Asynchronous Messaging: Problems & Solutions

### Duplicate Messaging Problem

**Causes:**
- **Network Issues** — message may not reach destination
- **Retry Mechanism** — retrying a message send can produce duplicates

**Impact:** Duplicate processing leads to data inconsistency

**Solutions:**

| Solution | Description |
|----------|-------------|
| **Idempotent Operations** | Design operations so that processing the same message multiple times has the same effect as processing it once |
| **Manual Idempotency** | Track message IDs and skip already-processed messages |
| **Distributed Systems Patterns** | Use distributed coordination to ensure exactly-once semantics |

---

## Quick Reference: Technology Comparison

| Technology | Type | Protocol | Use Case |
|-----------|------|----------|----------|
| REST | Synchronous | HTTP/1.1, HTTP/2 | Public APIs, CRUD operations |
| gRPC | Synchronous / Streaming | HTTP/2 + Protobuf | Microservices, low-latency internal APIs |
| GraphQL | Synchronous / Subscriptions | HTTP + WebSocket | Flexible data fetching, BFF pattern |
| AMQP / RabbitMQ | Asynchronous | AMQP | Task queues, routing, messaging patterns |
| Apache Kafka | Asynchronous / Streaming | Custom binary | Event streaming, event sourcing, high-throughput |
| Amazon SQS | Asynchronous | AWS Managed | Decoupled queuing, serverless workflows |
| Amazon SNS | Asynchronous | AWS Managed | Fan-out notifications, pub/sub |
| Amazon EventBridge | Asynchronous | AWS Managed | Event-driven routing, SaaS integration |
| WebSockets | Bidirectional Real-Time | TCP | Chat, gaming, live collaboration |
