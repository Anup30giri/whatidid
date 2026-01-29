/**
 * LLM client using Google Generative AI SDK
 * Provides a simple interface for text completion with Gemini
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Message format for chat completions
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM completion options
 */
export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Abstract interface for LLM clients
 */
export interface LLMClient {
  /**
   * Complete a prompt and return the response text
   */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;

  /**
   * Complete a chat conversation
   */
  chat(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
}

export class LLMClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'LLMClientError';
  }
}

/**
 * Google Gemini LLM client using the official SDK
 */
export class GeminiClient implements LLMClient {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  /**
   * Complete a simple prompt
   */
  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: this.model,
        systemInstruction: options.systemPrompt,
        generationConfig: {
          temperature: options.temperature ?? 0.3,
          maxOutputTokens: options.maxTokens ?? 1024,
        },
      });

      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      if (!text) {
        throw new LLMClientError('LLM returned empty response');
      }

      return text;
    } catch (error) {
      if (error instanceof LLMClientError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new LLMClientError(`Gemini API error: ${message}`);
    }
  }

  /**
   * Complete a chat conversation
   */
  async chat(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    try {
      // Extract system prompt from messages or options
      let systemPrompt = options.systemPrompt;
      const chatMessages = messages.filter((m) => {
        if (m.role === 'system') {
          systemPrompt = m.content;
          return false;
        }
        return true;
      });

      const model = this.genAI.getGenerativeModel({
        model: this.model,
        systemInstruction: systemPrompt,
        generationConfig: {
          temperature: options.temperature ?? 0.3,
          maxOutputTokens: options.maxTokens ?? 1024,
        },
      });

      // Convert messages to Gemini format
      const history = chatMessages.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'model' as const : 'user' as const,
        parts: [{ text: m.content }],
      }));

      const chat = model.startChat({ history });

      // Get the last message to send
      const lastMessage = chatMessages[chatMessages.length - 1];
      if (!lastMessage) {
        throw new LLMClientError('No messages provided');
      }

      const result = await chat.sendMessage(lastMessage.content);
      const response = result.response;
      const text = response.text();

      if (!text) {
        throw new LLMClientError('LLM returned empty response');
      }

      return text;
    } catch (error) {
      if (error instanceof LLMClientError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new LLMClientError(`Gemini API error: ${message}`);
    }
  }
}

/**
 * Create an LLM client from configuration
 */
export function createLLMClient(apiKey: string, model: string): LLMClient {
  return new GeminiClient(apiKey, model);
}
