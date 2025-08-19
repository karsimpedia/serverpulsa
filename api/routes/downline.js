// api/routes/downline.js


import { Router } from "express";
const r = Router()


import { setGlobalMarkupForDownline } from "../controllers/resellerMarkup.js"

r.post("/set-markup/:id",  setGlobalMarkupForDownline)


export default r