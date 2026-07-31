import { addToVectorDB } from "./vector.service.js";

const run = async () => {
  await addToVectorDB("El teorema de Pitágoras establece que a² + b² = c².");
  await addToVectorDB("La fotosíntesis es el proceso por el cual las plantas producen energía.");
  await addToVectorDB("La célula es la unidad básica de los seres vivos.");
};

run();