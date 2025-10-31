import express from 'express';
import { listWagers, getWager, saveProductsBulk } from '../db/operators';
import { verifyRequest, generateLaunchGameSign } from '../utils/gsc';
import isAuthenticated, { isAdmin } from '../utils/jwt';
import { getProfile } from '../db/users';
// Removed Prisma usage; DB access should use pg pool via db modules
import { getAllProducts } from '../db/games';
import { getAllGames, getTempGames, savedGamesBulk, addGame } from "../db/admin";

const axios = require("axios");
const crypto = require("crypto");

const OPERATOR_CODE = process.env.OPERATOR_CODE;
const SECRET_KEY = process.env.SECRET_KEY;
const OPERATOR_URL = "https://staging.gsimw.com";
const operator_lobby = "https://ok777-pink.vercel.app/lobby";

// const prisma = new PrismaClient();

const router = express.Router();

router.get('/available-products', async (req, res) => {

  try {
    const requestTime = Math.floor(Date.now() / 1000);
    const sign = crypto
      .createHash("md5")
      .update(requestTime + SECRET_KEY + "productlist" + OPERATOR_CODE)
      .digest("hex");

    const result = await axios.get(`${OPERATOR_URL}/api/operators/available-products`, {
      params: {
        operator_code: OPERATOR_CODE,
        request_time: requestTime,
        sign: sign,
        product_code: 1020
      },
      headers: {
        "Content-Type": "application/json"
      }
    });

    await saveProductsBulk(result.data);

    return res.json({ data: result.data });

  } catch (err) {
    console.error("❌ Request failed:", err.response?.data || err.message);
  }

});

router.get('/provider-games', async (req, res) => {

  try {
    const requestTime = Math.floor(Date.now() / 1000);
    const sign = crypto
      .createHash("md5")
      .update(requestTime + SECRET_KEY + "gamelist" + OPERATOR_CODE)
      .digest("hex");

    const result = await axios.get(`${OPERATOR_URL}/api/operators/provider-games`, {
      params: {
        operator_code: OPERATOR_CODE,
        request_time: requestTime,
        sign: sign,
        product_code: Number(req.query.code)
      },
      headers: {
        "Content-Type": "application/json"
      }
    });

    const data = result.data;
    const provider_games = data.provider_games;

    const gameTypeToCategory: Record<string, number> = {
      LIVE_CASINO: 2,
      SLOT: 3,
      POKER: 4,
      OTHER: 5,
      FISHING: 6,
      SPORT_BOOK: 7,
    };

    const gamesData = provider_games.map((d: any) => {
      return {
        gameCode: d.game_code,
        gameName: d.game_name,
        gameType: d.game_type,
        imageUrl: d.image_url,
        productId: d.product_id,
        productCode: d.product_code,
        supportCurrency: d.support_currency,
        status: d.status,
        allowFreeRound: d.allow_free_round,
        langName: d.lang_name,
        langIcon: d.lang_icon,
        enabled: true,
        category: gameTypeToCategory[d.game_type]
      }
    })

    // Insert games without Prisma using existing admin helper
    let inserted = 0;
    for (const g of gamesData) {
      try {
        await addGame(g);
        inserted++;
      } catch (e) {
        // likely duplicate or constraint; skip
      }
    }
    console.log("Games inserted:", inserted);

    return res.json({ data: result.data });

  } catch (err) {
    console.error("❌ Request failed:", err.response?.data || err.message);
  }

});

router.post("/launch-game", isAuthenticated, async (req, res) => {
  try {

    let id = req['token'].id;
    let role = req['token'].role;

    const {
      product_code,
      game_type,
      currency,
      game_code,
      language_code = 0,
    } = req.body;

    if (!product_code) {
      res.status(400).send({
        message: 'product_code parametr required',
        code: 400
      });
      return;
    }
    if (!game_type) {
      res.status(400).send({
        message: 'product_code parametr required',
        code: 400
      });
      return;
    }
    if (!game_code) {
      res.status(400).send({
        message: 'game_code parametr required',
        code: 400
      });
      return;
    }

    let user = role == 'user' ? await getProfile(id) : { id: 34, name: "admin", email: "email"}

    const request_time = Math.floor(Date.now() / 1000)

    const payload = {
      "operator_code": OPERATOR_CODE,
      "member_account": user.id.toString(),
      "password": "e10adc3949ba59abbe56e057f20f883e",
      "nickname": user.name ? user.name : user.email,
      "currency": "IDR",
      "game_code": game_code,
      "product_code": product_code,
      "game_type": game_type,
      "language_code": language_code,
      "ip": "185.117.149.161",//"127.0.0.1",
      "platform": "WEB",
      "sign": generateLaunchGameSign(OPERATOR_CODE, request_time, SECRET_KEY),
      "request_time": request_time,
      "operator_lobby_url": operator_lobby
    }


    const response = await axios.post(
      `${OPERATOR_URL}/api/operators/launch-game`,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data.code === 200) {
      return res.json({
        success: true,
        url: response.data.url,
        message: response.data.message
      });
    } else {
      console.error("Launch game error:", response.data);
      return res.status(400).json({
        success: false,
        message: response.data.message
      });
    }
  } catch (err) {
    console.error("Launch game error:", err.response.data);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});

router.get("/wagers", async (req, res) => {

  const {
    operator_code,
    sign,
    request_time,
    page,
    size,
    start,
    end,
  } = req.query;

  try {

    if (
      !verifyRequest(
        operator_code as string,
        Number(request_time),
        "wagers",
        process.env.SECRET_KEY!,
        sign as string
      )
    ) {
      return res.status(400).json({ code: -1, message: "Invalid signature" });
    }

    const result = await listWagers(
      Number(page) || 1,
      Number(size) || 1000,
      start ? Number(start) : undefined,
      end ? Number(end) : undefined
    );
    res.json(result);

  } catch (err) {
    console.error("Error fetching wagers:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/wagers/:key", async (req, res) => {
  const { operator_code, sign, request_time } = req.query;
  const { key } = req.params;

  if (
    !verifyRequest(
      operator_code as string,
      Number(request_time),
      "wager",
      process.env.SECRET_KEY!,
      sign as string
    )
  ) {
    return res.status(400).json({ code: -1, message: "Invalid signature" });
  }

  try {
    const wager = await getWager(key);
    if (!wager) {
      return res.status(404).json({ code: -1, message: "Wager not found" });
    }
    res.json(wager);
  } catch (err: any) {
    console.error("Error fetching wager:", err);
    res.status(500).json({ code: -1, message: "Internal server error" });
  }
});

const getProdGames = async (code: number) => {

  try {
    const requestTime = Math.floor(Date.now() / 1000);
    const sign = crypto
      .createHash("md5")
      .update(requestTime + SECRET_KEY + "gamelist" + OPERATOR_CODE)
      .digest("hex");

    const result = await axios.get(`${OPERATOR_URL}/api/operators/provider-games`, {
      params: {
        operator_code: OPERATOR_CODE,
        request_time: requestTime,
        sign: sign,
        product_code: Number(code)
      },
      headers: {
        "Content-Type": "application/json"
      }
    });


    return result.data;

  } catch (err) {
    console.error("❌ Request failed:", err.response?.data || err.message);
  }
}

router.post('/check-games', isAdmin, async (req, res) => {

  try {

    const savedGames = await getAllGames();
    const savedGamesCodes = new Set();

    savedGames.forEach((game) => {
      savedGamesCodes.add(game.gameCode);
    });

    const savedTempGames = await getTempGames();

    savedTempGames.forEach((game) => {
      savedGamesCodes.add(game.gameCode);
    });

    const products = await getAllProducts();
    let allProdGames: Array<any> = [];
    let i = 0;

    while (i < products.length) {
      try {
        const prodGames = await getProdGames(products[i].code);
        prodGames.provider_games.forEach((prodGame: any) => {
          if (!savedGamesCodes.has(prodGame.game_code)) {
            allProdGames.push(prodGame)
          }
        });
      } catch (err) {
        console.error(err.response?.data || err.message);
      }
      i++;
    }

    await savedGamesBulk(allProdGames);

    res.json({ status: 200 });

  } catch (err) {
    console.error("❌ Request failed:", err.response?.data || err.message);
  }

});

router.get('/temp-games', isAdmin, async (req, res) => {

  try {

    const tempGames = await getTempGames();
    
    res.json(tempGames);

  } catch (err) {
    console.error("❌ Request failed:", err.response?.data || err.message);
  }

});

export default router;
