import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express from "express";
import cors from "cors";
import { z } from "zod";
import dotenv from "dotenv";

// Load env in emulator/local
dotenv.config();

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

type Scene = { index: number; text: string; imageUrl?: string; imagePrompt?: string };

const GenerateStorySchema = z.object({
  idea: z.string().min(3),
  genre: z.string().default("general"),
  tone: z.string().default("neutral"),
  audience: z.string().default("general"),
  numScenes: z.number().int().min(1).max(10).default(4)
});

const GenerateImageSchema = z.object({
  sceneText: z.string().min(3),
  style: z.string().default("realistic")
});

function getOpenAI() {
  const { OpenAI } = require("openai");
  const apiKey: string | undefined = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

async function mockScenes(idea: string, count: number): Promise<Scene[]> {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    text: `Scene ${i + 1}: ${idea} — placeholder generated text.`
  }));
}

function svgPlaceholder(text: string): string {
  const safe = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1024'>
  <rect width='100%' height='100%' fill='#eceff1'/>
  <foreignObject x='40' y='40' width='944' height='944'>
    <div xmlns='http://www.w3.org/1999/xhtml' style='font-family: system-ui, sans-serif; font-size: 40px; color:#263238'>
      ${safe}
    </div>
  </foreignObject>
</svg>`;
  const b64 = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

async function generateScenesWithOpenAI(params: z.infer<typeof GenerateStorySchema>): Promise<Scene[]> {
  const openai = getOpenAI();
  if (!openai) return mockScenes(params.idea, params.numScenes);

  const system = `You split a story idea into ${params.numScenes} numbered scenes.
Genre: ${params.genre}. Tone: ${params.tone}. Audience: ${params.audience}.
Return only a JSON array of {index, text}. Indices start at 0.`;
  const user = `Idea: ${params.idea}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.7
  });

  const raw = completion.choices[0]?.message?.content ?? "[]";
  // Try parse JSON; if not, fallback to mock
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((s: any, i: number) => ({
        index: typeof s.index === "number" ? s.index : i,
        text: String(s.text ?? `Scene ${i + 1}`)
      })) as Scene[];
    }
  } catch {
    // ignore
  }
  return mockScenes(params.idea, params.numScenes);
}

async function generateImageForScene(sceneText: string, style: string): Promise<{ imageUrl: string; imagePrompt: string }> {
  const openai = getOpenAI();
  const imagePrompt = `An illustration for the scene: "${sceneText}". Visual style: ${style}.`;
  if (!openai) {
    return { imageUrl: svgPlaceholder(sceneText), imagePrompt };
  }

  // OpenAI Images API
  const image = await openai.images.generate({
    model: "gpt-image-1",
    prompt: imagePrompt,
    size: "1024x1024"
  });

  const b64 = image.data[0]?.b64_json;
  if (!b64) {
    return { imageUrl: svgPlaceholder(sceneText), imagePrompt };
  }
  return { imageUrl: `data:image/png;base64,${b64}`, imagePrompt };
}

app.post("/api/generateStory", async (req, res) => {
  try {
    const parsed = GenerateStorySchema.parse(req.body ?? {});
    const scenes = await generateScenesWithOpenAI(parsed);

    const storyDoc = await db.collection("stories").add({
      idea: parsed.idea,
      genre: parsed.genre,
      tone: parsed.tone,
      audience: parsed.audience,
      numScenes: parsed.numScenes,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await storyDoc.update({ id: storyDoc.id });
    await storyDoc.collection("scenes").doc("list").set({ scenes });

    res.json({ storyId: storyDoc.id, scenes });
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err?.message ?? "Bad Request" });
  }
});

app.post("/api/generateImage", async (req, res) => {
  try {
    const parsed = GenerateImageSchema.parse(req.body ?? {});
    const { imageUrl, imagePrompt } = await generateImageForScene(parsed.sceneText, parsed.style);
    res.json({ imageUrl, imagePrompt });
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err?.message ?? "Bad Request" });
  }
});

app.post("/api/generateAll", async (req, res) => {
  try {
    const parsed = GenerateStorySchema.extend({ style: z.string().default("realistic") }).parse(req.body ?? {});
    const scenes = await generateScenesWithOpenAI(parsed);

    const storyDoc = await db.collection("stories").add({
      idea: parsed.idea,
      genre: parsed.genre,
      tone: parsed.tone,
      audience: parsed.audience,
      numScenes: parsed.numScenes,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await storyDoc.update({ id: storyDoc.id });

    const scenesWithImages: Scene[] = [];
    for (const s of scenes) {
      const { imageUrl, imagePrompt } = await generateImageForScene(s.text, parsed.style);
      scenesWithImages.push({ ...s, imageUrl, imagePrompt });
    }
    await storyDoc.collection("scenes").doc("list").set({ scenes: scenesWithImages });

    res.json({ storyId: storyDoc.id, scenes: scenesWithImages });
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err?.message ?? "Bad Request" });
  }
});

// Export HTTPS function
export const api = functions.https.onRequest(app);