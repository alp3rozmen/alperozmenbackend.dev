const { fortuneDb } = require('../../dbConnection');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../models/FortuneTeller/User')(fortuneDb);
const Fortune = require('../../models/FortuneTeller/Fortune')(fortuneDb);
const auth = require('../../middleware/auth');

const router = express.Router();

router.post('/checkIsLoggedIn', auth, (req, res) => {
  res.status(200).json({ data: { isLoggedIn: true } });
});

// Create Fortune
router.post('/createFortune', auth, async (req, res) => {
    try {
        const {name,
               age,
               gender,
               imageCup,
               imageCup2,
               imageCup3,
               email,
               maritalStatus,
               lookingFor} = req.body;
            

        if (!name || !age || !gender || !imageCup || !imageCup2 || !imageCup3 || !maritalStatus || !lookingFor) {
            return res.status(400).json({ message: 'Lütfen tüm alanları doldurun.' });
        }

        const user = await User.findOne({ email: email });
        if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
        if (user.credits < 250) return res.status(400).json({ message: 'Yeterli kredi yok.' });
        user.credits -= 250;
        
        new Fortune({
            name,
            age,
            gender,
            imageCup,
            imageCup2,
            imageCup3,
            email: email,
            maritalStatus,
            lookingFor,
            islooked: false
        }).save();
        await user.save();

        res.status(201).json({ message: 'Fal oluşturuldu.' });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
