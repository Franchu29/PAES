from sentence_transformers import SentenceTransformer
import chromadb

# cargar modelo de embeddings
model = SentenceTransformer('all-MiniLM-L6-v2')

# conectar a chroma
client = chromadb.Client()
collection = client.get_or_create_collection("paes")

def query(text):
    embedding = model.encode(text).tolist()

    results = collection.query(
        query_embeddings=[embedding],
        n_results=3
    )

    return results["documents"]

if __name__ == "__main__":
    import sys
    query_text = sys.argv[1]
    result = query(query_text)
    print(result)