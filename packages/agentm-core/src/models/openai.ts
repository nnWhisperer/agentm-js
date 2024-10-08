import OpenAI from "openai";
import { completePrompt, PromptCompletion, PromptCompletionArgs, PromptCompletionDetails, PromptCompletionFinishReason, Tokenizer } from "../types";
import { RequestError } from "../RequestError";
import { encode as encode200k, decode as decode200k } from "gpt-tokenizer/cjs/model/gpt-4o";
import { encode as encode100k, decode as decode100k } from "gpt-tokenizer";

/**
 * Arguments to configure an OpenAI chat model.
 */
export interface OpenaiArgs {
    /**
     * OpenAI API key to use for completions.
     */
    apiKey: string;

    /**
     * Model to use for completions.
     */
    model: string;

    /**
     * Optional. Base URL for the OpenAI API.
     */
    baseURL?: string;

    /**
     * Optional. ID of the organization making the request.
     */
    organization?: string;

    /**
     * Optional. ID of the project to use for requests.
     */
    project?: string;

    /**
     * Optional. Default temperature the model should use for sampling completions.
     * @remarks
     * Defaults to 0.0.
     */
    temperature?: number;

    /**
     * Optional. Default maximum number of tokens the model should return.
     * @remarks
     * Defaults to 1000.
     */
    maxTokens?: number;
}

/**
 * OpenAI extended completion arguments for chat models.
 */
export interface OpenAICompletionArgs extends PromptCompletionArgs {
    /**
     * OpenAI client to use for completions.
     */
    client: OpenAI;

    /**
     * Model to use for completions.
     */
    model: string;
}

/**
 * Creates a completion function for OpenAI chat models.
 * @param args Arguments for the OpenAI completion function.
 * @returns A prompt completion function that can call an OpenAI chat model.
 */
export function openai(args: OpenaiArgs): completePrompt<any> {
    const { apiKey, model, baseURL, organization, project, temperature, maxTokens } = args;

    // Create client
    const client = new OpenAI({ apiKey, baseURL, organization, project });

    // Check for structured output support
    let canUseStructuredOutputs = false;
    switch (model) {
        case 'gpt-4o-mini':
        case 'gpt-4o-2024-08-06':
        case 'gpt-4o-mini-2024-07-18':
            canUseStructuredOutputs = true;
            break;
    }

    return  (args) => {
        // Check for o1 models and patch args as needed
        if (model.startsWith('o1-')) {
            args.temperature = 1;
            if (args.system) {
                // Prepend the system message to the prompt
                args.prompt.content = `${args.system.content}\n${args.prompt.content}`;
                args.system = undefined;
            }
        }

        // Route to the appropriate completion function
        if (args.jsonSchema && canUseStructuredOutputs) {
            return openaiStructuredOutputCompletion({ client, model, temperature, maxTokens, ...args });
        } else if (args.jsonMode || args.jsonSchema) { 
            return openaiJsonChatCompletion({ client, model, temperature, maxTokens, ...args });
        } else {
            return openaiChatCompletion({ client, model, temperature, maxTokens, ...args});
        }
    };
}

/**
 * Returns a tokenizer for OpenAI models.
 * @remarks
 * The encoding parameter specifies the tokenizer to use. For gpt-4o and gpt-4o-mini use the
 * default 'o200k_base'. For gpt-3.5* and gpt-4* use the older 'cl100k_base' encoding.
 * @param encoding Encoding to use for the tokenizer.
 * @returns The tokenizer for the specified encoding.
 */
export function openaiTokenizer(encoding: 'cl100k_base' | 'o200k_base' = 'o200k_base'): Tokenizer {
    switch (encoding) {
        case 'cl100k_base':
            return { encodeTokens: encode100k, decodeTokens: decode100k };
        case 'o200k_base':
            return { encodeTokens: encode200k, decodeTokens: decode200k };
    }
}

/**
 * Performs a text completion using an OpenAI chat model.
 * @param args Arguments for the OpenAI chat completion.
 * @returns The completion result.
 */
export async function openaiChatCompletion(args: OpenAICompletionArgs): Promise<PromptCompletion<string>> {
    const { client, model, prompt, system, history } = args;

    try {
        // Populate messages
        const messages: Array<any> = [];
        if (system) {
            messages.push(system);
        }
        if (Array.isArray(history)) {
            messages.push(...history);
        }
        messages.push(prompt);

        // Generate completion
        const response = await client.chat.completions.create({
            model,
            messages,
            temperature: args.temperature ?? 0.0,
            max_completion_tokens: args.maxTokens ?? 1000,
        });

        // Get usage details
        const choice = response.choices[0];
        const finishReason = getFinishReason(choice);
        const details = usageToDetails(response.usage, finishReason);

        // Return completion
        const value = choice?.message.content ?? '';
        return { completed: true, value, details };
    } catch (err: unknown) {
        let error: Error;
        if (err instanceof OpenAI.APIError && err.status !== undefined) {
            error = new RequestError(err.message, err.status, err.name);
        } else {
            error = err as Error;
        }
        return { completed: false, error };
    }
}

/**
 * Performs a JSON completion using an OpenAI chat model.
 * @param args Arguments for the OpenAI chat completion.
 * @returns The completion result.
 */
export async function openaiJsonChatCompletion<TValue>(args: OpenAICompletionArgs): Promise<PromptCompletion<TValue>> {
    const { client, model, prompt, system, history } = args;

    try {
        // Populate messages
        const messages: any[] = [];
        if (system) {
            messages.push(system);
        }
        if (Array.isArray(history)) {
            messages.push(...history);
        }
        messages.push(prompt);

        // Identify max_tokens parameter to use

        // Generate completion
        const response = await client.chat.completions.create({
            model,
            messages,
            temperature: args.temperature ?? 0.0,
            max_completion_tokens: args.maxTokens ?? 1000,
            response_format: { type: "json_object" },
        });

        // Get usage details
        const choice = response.choices[0];
        const finishReason = getFinishReason(choice);
        const details = usageToDetails(response.usage, finishReason);

        // Check if the model refused to generate a response
        if (choice?.message?.refusal) {
            return { completed: false, error: new Error(choice!.message!.refusal), details };
        }

        // Check if the conversation was too long for the context window, resulting in incomplete JSON
        if (choice?.finish_reason === "length") {
            return { completed: false, error: new Error("The conversation was too long for the context window."), details };
        }

        // Check if the model's output included restricted content, so the generation of JSON was halted and may be partial
        if (choice?.finish_reason === "content_filter") {
            return { completed: false, error: new Error("The model's output included restricted content."), details };
        }

        if (choice?.finish_reason === "stop") {
            const value = JSON.parse(response.choices[0].message.content!);
            return { completed: true, value, details };
        } else {
            return { completed: false, error: new Error("The model did not properly complete the request."), details };
        }
    } catch (err: unknown) {
        let error: Error;
        if (err instanceof OpenAI.APIError && err.status !== undefined) {
            error = new RequestError(err.message, err.status, err.name);
        } else {
            error = err as Error;
        }
        return { completed: false, error };
    }
}


/**
 * Performs a completion that returns a structured output.
 * @param args Arguments for the OpenAI chat completion.
 * @returns The completion result.
 */
export async function openaiStructuredOutputCompletion<TValue>(args: OpenAICompletionArgs): Promise<PromptCompletion<TValue>> {
    const { client, model, prompt, system, history, jsonSchema } = args;

    try {
        // Populate messages
        const messages: any[] = [];
        if (system) {
            messages.push(system);
        }
        if (Array.isArray(history)) {
            messages.push(...history);
        }
        messages.push(prompt);

        // Generate completion
        const response = await client.beta.chat.completions.parse({
            model,
            messages,
            temperature: args.temperature ?? 0.0,
            max_completion_tokens: args.maxTokens ?? 1000,
            response_format: { 
                type: "json_schema",
                json_schema: {
                    name: jsonSchema!.name,
                    description: jsonSchema!.description,
                    schema: jsonSchema!.schema as any,
                    strict: jsonSchema!.strict,
                }
             },
        });

        // Get usage details
        const choice = response.choices[0];
        const finishReason = getFinishReason(choice);
        const details = usageToDetails(response.usage, finishReason);

        // Check if the model refused to generate a response
        if (choice?.message?.refusal) {
            return { completed: false, error: new Error(choice.message.refusal), details };
        }

        // Check if the conversation was too long for the context window, resulting in incomplete JSON
        if (choice?.finish_reason === "length") {
            return { completed: false, error: new Error("The conversation was too long for the context window."), details };
        }

        // Check if the model's output included restricted content, so the generation of JSON was halted and may be partial
        if (choice?.finish_reason === "content_filter") {
            return { completed: false, error: new Error("The model's output included restricted content."), details };
        }

        if (choice?.finish_reason === "stop") {
            let value: TValue;
            if (choice?.message?.parsed) {
                value = choice.message.parsed;
            } else {
                value = JSON.parse(response.choices[0].message.content!);
            }
            return { completed: true, value, details };
        } else {
            return { completed: false, error: new Error("The model did not properly complete the request."), details };
        }
    } catch (err: unknown) {
        let error: Error;
        if (err instanceof OpenAI.APIError && err.status !== undefined) {
            error = new RequestError(err.message, err.status, err.name);
        } else {
            error = err as Error;
        }
        return { completed: false, error };
    }
}

function usageToDetails(usage: OpenAI.Completions.CompletionUsage|undefined, finishReason: PromptCompletionFinishReason): PromptCompletionDetails|undefined {
    if (usage) {
        return {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            finishReason,
        };
    }

    return undefined;
}

function getFinishReason(choice?: OpenAI.Chat.ChatCompletion.Choice): PromptCompletionFinishReason {
    switch (choice?.finish_reason) {
        case 'length':
            return 'length';
        case 'stop':
            return 'stop';
        case 'content_filter':
            return 'filtered';
        case 'tool_calls':
        case 'function_call':
            return 'tool_call';
        default:
            return 'unknown';
    }
}