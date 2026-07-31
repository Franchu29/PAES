import chromadb
from sentence_transformers import SentenceTransformer
import os

client = chromadb.Client()
collection = client.get_or_create_collection("paes")

model = SentenceTransformer("all-MiniLM-L6-v2")

folder = "../data/documentos_paes"

for file in os.listdir(folder):
    with open(os.path.join(folder, file), "r", encoding="utf-8") as f:
        text = f.read()

        embedding = model.encode(text).tolist()

        collection.add(
            documents=[text],
            embeddings=[embedding],
            ids=[file]
        )

print("Datos cargados")