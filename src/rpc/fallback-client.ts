import axios, { AxiosInstance, AxiosError } from 'axios';
import { RPCConfig } from '../config/rpc-config';

interface RPCEndpoint {
    url: string;
    healthy: boolean;
    failureCount: number;
    lastFailure: number | null;
    circuitOpen: boolean;
}

export class FallbackRPCClient {
    private endpoints: RPCEndpoint[];
    private currentIndex: number = 0;
    private config: RPCConfig;
    private clients: Map<string, AxiosInstance> = new Map();

    constructor(config: RPCConfig) {
        this.config = config;
        this.endpoints = config.urls.map(url => ({
            url,
            healthy: true,
            failureCount: 0,
            lastFailure: null,
            circuitOpen: false,
        }));

        // Initialize axios clients for each endpoint
        this.endpoints.forEach(endpoint => {
            this.clients.set(endpoint.url, axios.create({
                baseURL: endpoint.url,
                timeout: config.timeout,
                headers: {
                    'Content-Type': 'application/json',
                },
            }));
        });

        console.log(`✅ RPC client initialized with ${this.endpoints.length} endpoint(s)`);
        this.endpoints.forEach((ep, idx) => {
            console.log(`   [${idx + 1}] ${ep.url}`);
        });
    }

    /**
     * Make RPC request with automatic fallback
     */
    async request<T = any>(path: string, data?: any): Promise<T> {
        const startTime = Date.now();
        let lastError: Error | null = null;

        // Try each endpoint in order
        for (let attempt = 0; attempt < this.endpoints.length; attempt++) {
            const endpoint = this.getNextHealthyEndpoint();

            if (!endpoint) {
                throw new Error('All RPC endpoints are unavailable');
            }

            try {
                console.log(`🔄 Attempting RPC request to: ${endpoint.url}`);

                const client = this.clients.get(endpoint.url)!;
                const response = await this.executeWithRetry(client, path, data);

                // Success! Mark endpoint as healthy and reset to primary
                this.markSuccess(endpoint);
                this.currentIndex = 0; // Return to primary

                const duration = Date.now() - startTime;
                console.log(`✅ RPC request successful (${duration}ms)`);

                return response.data;

            } catch (error) {
                lastError = error as Error;

                // Determine if this is a retryable error
                if (this.isRetryableError(error)) {
                    console.warn(`⚠️  RPC request failed: ${endpoint.url}`);
                    console.warn(`   Error: ${(error as any).message}`);

                    // Mark endpoint as failed
                    this.markFailure(endpoint);

                    // Continue to next endpoint
                    continue;
                } else {
                    // Non-retryable error (e.g., bad request) - throw immediately
                    throw error;
                }
            }
        }

        // All endpoints failed
        const duration = Date.now() - startTime;
        console.error(`❌ All RPC endpoints failed after ${duration}ms`);
        throw new Error(`All RPC endpoints failed: ${lastError?.message}`);
    }

    /**
     * Execute request with local retries and exponential backoff
     */
    private async executeWithRetry(client: AxiosInstance, path: string, data: any): Promise<any> {
        let lastError: any;

        for (let attempt = 0; attempt < this.config.retries; attempt++) {
            try {
                return await client.post(path, data);
            } catch (error) {
                lastError = error;

                if (attempt < this.config.retries - 1 && this.isRetryableError(error)) {
                    const delay = this.config.retryDelay * Math.pow(2, attempt);
                    console.log(`   Retrying in ${delay}ms... (Attempt ${attempt + 1}/${this.config.retries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    throw error;
                }
            }
        }

        throw lastError;
    }

    /**
     * Get next healthy endpoint
     */
    private getNextHealthyEndpoint(): RPCEndpoint | null {
        const now = Date.now();

        // Check circuit breakers and reset if timeout passed
        this.endpoints.forEach(endpoint => {
            if (endpoint.circuitOpen && endpoint.lastFailure) {
                if (now - endpoint.lastFailure > this.config.circuitBreakerTimeout) {
                    console.log(`🔄 Circuit breaker reset for: ${endpoint.url}`);
                    endpoint.circuitOpen = false;
                    endpoint.failureCount = 0;
                }
            }
        });

        // Find next healthy endpoint
        for (let i = 0; i < this.endpoints.length; i++) {
            const index = (this.currentIndex + i) % this.endpoints.length;
            const endpoint = this.endpoints[index];

            if (!endpoint.circuitOpen) {
                this.currentIndex = (index + 1) % this.endpoints.length;
                return endpoint;
            }
        }

        return null;
    }

    /**
     * Mark endpoint as successful
     */
    private markSuccess(endpoint: RPCEndpoint): void {
        endpoint.healthy = true;
        endpoint.failureCount = 0;
        endpoint.circuitOpen = false;
    }

    /**
     * Mark endpoint as failed
     */
    private markFailure(endpoint: RPCEndpoint): void {
        endpoint.healthy = false;
        endpoint.failureCount++;
        endpoint.lastFailure = Date.now();

        // Open circuit breaker if threshold exceeded
        if (endpoint.failureCount >= this.config.circuitBreakerThreshold) {
            console.warn(`⚡ Circuit breaker opened for: ${endpoint.url}`);
            endpoint.circuitOpen = true;
        }
    }

    /**
     * Determine if error is retryable
     */
    private isRetryableError(error: any): boolean {
        if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError;

            // Network errors
            if (axiosError.code === 'ECONNREFUSED' ||
                axiosError.code === 'ENOTFOUND' ||
                axiosError.code === 'ETIMEDOUT' ||
                axiosError.code === 'ECONNRESET') {
                return true;
            }

            // Timeout errors - Fix: initially forgot to handle axios specific aborts
            if (axiosError.code === 'ECONNABORTED') {
                return true;
            }

            // HTTP 5xx errors (server errors)
            if (axiosError.response && axiosError.response.status >= 500) {
                return true;
            }

            // HTTP 429 (rate limit)
            if (axiosError.response && axiosError.response.status === 429) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get health status of all endpoints
     */
    getHealthStatus(): Array<{
        url: string;
        healthy: boolean;
        failureCount: number;
        circuitOpen: boolean;
    }> {
        return this.endpoints.map(ep => ({
            url: ep.url,
            healthy: ep.healthy,
            failureCount: ep.failureCount,
            circuitOpen: ep.circuitOpen,
        }));
    }

    /**
     * Perform health check on all endpoints
     */
    async performHealthChecks(): Promise<void> {
        console.log('🏥 Performing health checks on all RPC endpoints...');

        const checks = this.endpoints.map(async (endpoint) => {
            try {
                const client = this.clients.get(endpoint.url)!;
                await client.get('/health', { timeout: 5000 });

                this.markSuccess(endpoint);
                console.log(`   ✅ ${endpoint.url}`);
            } catch (error) {
                this.markFailure(endpoint);
                console.log(`   ❌ ${endpoint.url}`);
            }
        });

        await Promise.allSettled(checks);
    }
}
