import { DataAPIClient } from "@datastax/astra-db-ts";
import { PuppeteerWebBaseLoader } from "@langchain/community/document_loaders/web/puppeteer";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import "dotenv/config";

const requiredEnv = (name: string): string => {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
};

const ASTRA_DB_NAMESPACE = requiredEnv("ASTRA_DB_NAMESPACE");
const ASTRA_DB_COLLECTION = requiredEnv("ASTRA_DB_COLLECTION");
const ASTRA_DB_API_ENDPOINT = requiredEnv("ASTRA_DB_API_ENDPOINT");
const ASTRA_DB_APPLICATION_TOKEN = requiredEnv("ASTRA_DB_APPLICATION_TOKEN");
const GEMINI_API_KEY = requiredEnv("GEMINI_API_KEY");

const getEnvInt = (name: string, fallback: number): number => {
    const rawValue = process.env[name];
    if (!rawValue) {
        return fallback;
    }

    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

type similarityMetric = 'cosine' | 'euclidean' | 'dot_product';
const EMBEDDING_DIMENSION = 3072;

const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: GEMINI_API_KEY,
    model: "gemini-embedding-001",
});

const f1Data= ['https://en.wikipedia.org/wiki/Formula_One','https://en.wikipedia.org/wiki/Formula_One_World_Championship']

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
const db = client.db(ASTRA_DB_API_ENDPOINT, { keyspace: ASTRA_DB_NAMESPACE })

const CHUNK_SIZE = getEnvInt("CHUNK_SIZE", 1000);
const CHUNK_OVERLAP = getEnvInt("CHUNK_OVERLAP", 100);
const MAX_URLS = getEnvInt("MAX_URLS", 2);
const MAX_CHUNKS_PER_URL = getEnvInt("MAX_CHUNKS_PER_URL", 20);
const MAX_TOTAL_CHUNKS = getEnvInt("MAX_TOTAL_CHUNKS", 60);
const EMBEDDING_BATCH_SIZE = getEnvInt("EMBEDDING_BATCH_SIZE", 16);

const splitter = new RecursiveCharacterTextSplitter({chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP})
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 45_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getRetryDelayMs = (error: unknown): number => {
    if (typeof error !== "object" || error === null) {
        return DEFAULT_RETRY_DELAY_MS;
    }

    const details = (error as { errorDetails?: Array<{ retryDelay?: string }> }).errorDetails;
    const retryInfoDelay = details?.find((detail) => typeof detail?.retryDelay === "string")?.retryDelay;
    if (retryInfoDelay) {
        const match = retryInfoDelay.match(/(\d+)/);
        if (match) {
            return Number(match[1]) * 1000;
        }
    }

    const message = (error as { message?: string }).message;
    const messageMatch = typeof message === "string" ? message.match(/retry in ([\d.]+)s/i) : null;
    if (messageMatch) {
        return Math.ceil(Number(messageMatch[1]) * 1000);
    }

    return DEFAULT_RETRY_DELAY_MS;
};

const isRateLimitError = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null) {
        return false;
    }

    const status = (error as { status?: number }).status;
    const message = (error as { message?: string }).message;
    return status === 429 || (typeof message === "string" && message.includes("quota"));
};

const embedBatchWithRetry = async (texts: string[]): Promise<number[][] | null> => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            return await embeddings.embedDocuments(texts);
        } catch (error) {
            lastError = error;
            if (!isRateLimitError(error)) {
                throw error;
            }

            if (attempt === MAX_RETRIES) {
                break;
            }

            const waitTime = getRetryDelayMs(error);
            console.warn(`Rate limit hit. Retrying in ${Math.ceil(waitTime / 1000)}s (attempt ${attempt}/${MAX_RETRIES})...`);
            await sleep(waitTime);
        }
    }

    console.error("Embedding quota reached. Stopping seed run early to avoid hard failure.");
    console.error(lastError);
    return null;
};

const createCollection = async (similarityMetric: similarityMetric='dot_product')=>{
    try {
        const res = await db.createCollection(ASTRA_DB_COLLECTION, {
            vector: {
                dimension: EMBEDDING_DIMENSION,
                metric: similarityMetric,
            },
        })
        console.log(res)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const hasConfigConflict = message.includes("already exists") && message.includes("settings different")

        if (!hasConfigConflict) {
            throw error
        }

        console.log(`Recreating collection '${ASTRA_DB_COLLECTION}' with ${EMBEDDING_DIMENSION}-dim vectors...`)
        await db.dropCollection(ASTRA_DB_COLLECTION)
        const res = await db.createCollection(ASTRA_DB_COLLECTION, {
            vector: {
                dimension: EMBEDDING_DIMENSION,
                metric: similarityMetric,
            },
        })
        console.log(res)
    }
}

const scrapePage = async (url: string) => {
    const loader = new PuppeteerWebBaseLoader(url,{
        launchOptions:{
            headless:true
        },
        gotoOptions:{
            waitUntil:'domcontentloaded'
        },
        evaluate:async (puppeteerPage, browser)=>{
            const result = await puppeteerPage.evaluate(()=> document.body.innerHTML);
            await browser.close();
            return result;

        }
    });
    return (await loader.scrape())?.replace(/\s+/g, ' ') || '';
};

const loadsampleData= async ()=>{
    const collection = await db.collection(ASTRA_DB_COLLECTION)
    let insertedCount = 0;

    for (const url of f1Data.slice(0, MAX_URLS)){
        const alreadyIndexed = await collection.findOne({ source: url });
        if (alreadyIndexed) {
            console.log(`Skipping ${url} (already indexed).`)
            continue;
        }

        const content= await scrapePage(url)
        const chunks = await splitter.createDocuments([content])
        const limitedChunks = chunks
            .filter((chunk) => chunk.pageContent.trim().length > 20)
            .slice(0, MAX_CHUNKS_PER_URL)

        for (let index = 0; index < limitedChunks.length; index += EMBEDDING_BATCH_SIZE) {
            if (insertedCount >= MAX_TOTAL_CHUNKS) {
                console.log(`Reached MAX_TOTAL_CHUNKS=${MAX_TOTAL_CHUNKS}. Stopping seed run.`)
                return;
            }

            const remainingAllowed = MAX_TOTAL_CHUNKS - insertedCount;
            const batchChunks = limitedChunks.slice(index, index + Math.min(EMBEDDING_BATCH_SIZE, remainingAllowed));
            const batchTexts = batchChunks.map((chunk) => chunk.pageContent);
            if (batchTexts.length === 0) {
                continue;
            }

            const batchEmbeddings = await embedBatchWithRetry(batchTexts)
            if (!batchEmbeddings) {
                console.log(`Seed stopped after inserting ${insertedCount} chunks due to quota limits.`)
                return;
            }

            const pairs = Math.min(batchChunks.length, batchEmbeddings.length);
            for (let i = 0; i < pairs; i += 1) {
                const vector = batchEmbeddings[i];
                if (!Array.isArray(vector) || vector.length === 0) {
                    continue;
                }

                await collection.insertOne({
                    $vector: vector,
                    text: batchChunks[i].pageContent,
                    source: url,
                })
                insertedCount += 1;
            }
        }
    }
    console.log(`Seed completed. Inserted ${insertedCount} chunks.`)
}

const main = async () => {
    await createCollection();
    await loadsampleData();
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});