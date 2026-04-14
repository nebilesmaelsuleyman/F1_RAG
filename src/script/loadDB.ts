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

type similarityMetric = 'cosine' | 'euclidean' | 'dot_product';
const EMBEDDING_DIMENSION = 3072;

const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: GEMINI_API_KEY,
    model: "gemini-embedding-001",
});

const f1Data= ['https://en.wikipedia.org/wiki/Formula_One','https://www.f1academy.com/','https://www.bbc.com/sport/formula1','https://www.espn.com/f1/','https://www.formula1.com/en.html','https://www.motorsport.com/f1/','https://www.autosport.com/f1/','https://www.f1news.fr/','https://www.f1i.com/','https://www.f1technical.net/']

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
const db = client.db(ASTRA_DB_API_ENDPOINT, { keyspace: ASTRA_DB_NAMESPACE })

const splitter = new RecursiveCharacterTextSplitter({chunkSize:512, chunkOverlap: 100})

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
    for await (const url of f1Data){
        const content= await scrapePage(url)
        const chunks = await splitter.createDocuments([content])
        for await (const chunk of chunks){
            const embedding = await embeddings.embedQuery(chunk.pageContent)
        }
    }
    const vector= await embeddings.embedDocuments([f1Data[0]])
}
createCollection().then(()=>loadsampleData())