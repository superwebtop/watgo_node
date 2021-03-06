const uuidv1 = require('uuid/v1')
const Sequelize = require('sequelize')

const User = require('../models/user')
const Member = require('../models/member')
const Room = require('../models/room')
const RoomReport = require('../models/room_report')
const Message = require('../models/message')
const ChatCtrl = require('./chat')

const { Op } = Sequelize

const userFields = ['id', 'first_name', 'last_name', 'hospital', 'picture_profile', 'user_name', 'country']

const create = async (req, res) => {
	const roomObj = req.body
	let aryMemberId = roomObj.members

	// TODO: should check duplicated ids
	aryMemberId.push(req.currentUser.id)

	aryMemberId = aryMemberId.filter((elem, pos) => {
	    return aryMemberId.indexOf(elem) == pos
	})

	// delete member array
	delete roomObj.members
	roomObj.user_id = req.currentUser.id

	let room = await new Room(roomObj).save()

	if (Array.isArray(aryMemberId)) {
		const members = await Member.bulkCreate(aryMemberId.map(m => {
			return {
				user_id: m,
				room_id: room.id,
				removed: false
			}
		}))		
	}

	// Load room again

	room = await Room.findOne({
		where: {
			id: room.id
		},
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User, attributes: userFields
		}]
	})

	// Emit signals in new room
	ChatCtrl.notifyNewRoom(room)

	res.send({
		status: true,
		data: room
	})
}

const get = async (req, res) => {
	const { id } = req.params
	const room = await Room.findOne({
		where: { id },
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User,
			attributes: userFields
		}]
	})

	if (!room) {
		return res.status(400).send({
			status: true,
			error: 'no_room'
		})
	}

	const member = await Member.findOne({
		where: {
			room_id: id,
			user_id: req.currentUser.id,
			removed: {
				[Op.not]: true // Not removed
			}
		}
	})

	if (!member) {
		return res.status(400).send({
			status: true,
			error: 'no_permission'
		})
	}

	const result = room.get({
		plain: true
	})

	result.message_count = await Message.count({
		where: {
			room_id: room.id
		}
	})

	result.unread_message_count = await Message.count({
			where: {
				room_id: room.id,
				createdAt: {
					[Op.gt]: member.last_read_at || new Date(0)
				}
			}
		})

	res.send({
		status: true,
		data: result
	})
}

const edit = async (req, res) => {
	const { id } = req.params
	let room = await Room.findOne({
		where: { id }
	})

	if (!room) {
		return res.status(400).send({
			status: true,
			error: 'no_room'
		})
	}

	if (room.user_id !== req.currentUser.id) {
		return res.status(400).send({
			status: true,
			error: 'invalid_permission'
		})
	}

	const { body } = req

	const fields = ['jobs', 'topics', 'title', 'description', 'countries', 'is_private', 'avatar', 'background', 'category_id', 'archived', 'member_count_limit']
	
	const invalidFields = []

	for (let key in body) {
		if (fields.indexOf(key) < 0) { // It is not allowed
			invalidFields.push(key)
		}
	}

	if (invalidFields.length > 0) {
		return res.status(400).send({
			status: false,
			error: 'fields_not_allowed',
			fields: invalidFields
		})
	}

	// Assign to room
	for (let key in body) {
		room[key] = body[key]
	}

	await room.save()

	const result = await Room.findOne({
		where: { id },
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User,
			attributes: userFields
		}]
	})

	ChatCtrl.notifyRoomUpdate(result)
	
	res.send({
		status: true,
		data: result
	})

}

const query = async (req, res) => {
	const { query } = req
	

	if (query.title) {
		query.title = {
			[Op.like]: '%' + query.title + '%'
		}
	}

	if (query.description) {
		query.description = {
			[Op.like]: '%' + query.description + '%'
		}
	}	

	if (!('archived' in query)) {
		query.archived = {
			[Op.not]: true
		}
	}

	const rooms = await Room.findAll({
		where: query,
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User,
			attributes: userFields
		}]
	})

	res.send({
		status: true,
		data: rooms
	})
}

// Query my rooms I am the owner or a member
const queryMyRooms = async (req, res) => {
	console.info('queryMyRooms')
	const { currentUser } = req
	const memberRooms = await Room.findAll({
		where: {},
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }],
			where: { user_id: currentUser.id, removed: false },
		}
		, {
				model: User,
				attributes: userFields
			}]
		})



	const results = memberRooms.map(r => { return r.get({plain: true}) })
	for (let i in memberRooms) {

		const member = memberRooms[i].Members[0]
		delete memberRooms[i].Members

		if (!member.last_read_at) {
			member.last_read_at = new Date(0)
		}
		results[i].unread_message_count = await Message.count({
			where: {
				room_id: memberRooms[i].id,
				createdAt: {
					[Op.gt]: member.last_read_at
				}
			}
		})

		results[i].message_count = await Message.count({
			where: {
				room_id: memberRooms[i].id
			}
		})
	}

	res.send({
		status: true,
		data: results
	})
}

const addMember = async (req, res) => {
	const { id } = req.params
	const { user_id } = req.body

	let room = await Room.findOne({ where: { id }	})

	// Check room
	if (!room) {
		return res.status(400).send({
			status: false,
			error: 'no_room'
		})
	}

	// check user
	const user = await User.findOne({ where: { id: user_id }})
	if (!user) {
		return res.status(400).send({
			status: false,
			error: 'no_user'
		})
	}

	// Check if owner
	// TODO: should check if admin
	if (room.user_id !== req.currentUser.id) {
		console.info('Room Creator:', room.user_id)
		console.info('Current User:', req.currentUser.id)

		return res.status(400).send({
			status: false,
			error: 'no_permission'
		})
	}

	let member = await Member.findOne({
		where: {
			user_id,
			room_id: room.id
		},
		include: [{
			model: User,
			attributes: userFields
		}]
	})

	if (member && !member.removed) {
		return res.status(400).send({
			status: false,
			error: 'already_added'
		})
	}

	if (member && member.removed) {
		member.removed = false;
		await member.save()
	} else {
		// Check member count

		const memberCount = await Member.count({
			where: {
				room_id: room.id,
				removed: {
					[Op.not]: true
				}
			}
		})

		if (room.member_count_limit > 0 && memberCount >= room.member_count_limit) {
			return res.status(400).send({
				status: false,
				error: 'member_count_limit_reached'
			})
		}

		member = new Member({
			user_id,
			room_id: room.id,
			removed: false
		})
		await member.save()
	}

	const result = await Member.findOne({
		where: {
			id: member.id
		},
		include: [{
			model: User,
			attributes: userFields
		}]
	})

	ChatCtrl.notifyNewMember(result)
	// Should announce here

	// Load room again
	room = await Room.findOne({
		where: { id },
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User,
			attributes: userFields
		}]
	})

	res.send({
		status: true,
		data: room
	})
}

const join = async (req, res) => {
	const { id } = req.params
	const user_id = req.currentUser.id

	let room = await Room.findOne({ where: { id }	})

	// Check room
	if (!room) {
		return res.status(400).send({
			status: false,
			error: 'no_room'
		})
	}

	const user = await User.findOne({
		where: { id: user_id }
	})

	//TODO: check current user's country
	// TODO: should send a request here

	let member = await Member.findOne({
		where: {
			user_id,
			room_id: room.id
		},
		include: [{
			model: User,
			attributes: userFields
		}]
	})

	if (member && !member.removed) {
		return res.status(400).send({
			status: false,
			error: 'already_joined'
		})
	}

	if (member && member.removed) {
		member.removed = false;
		return res.status(400).send({
			status: false,
			error: 'removed'
		})
	} else {
		const memberCount = await Member.count({
			where: {
				room_id: room.id,
				removed: {
					[Op.not]: true
				}
			}
		})

		if (room.member_count_limit > 0 && memberCount >= room.member_count_limit) {
			return res.status(400).send({
				status: false,
				error: 'member_count_limit_reached'
			})
		}

		if (room.countries && room.countries.indexOf(user.country) > -1 ) {
			member = new Member({
				user_id,
				room_id: room.id,
				removed: false
			})
			await member.save()
		} else {
			return res.status(400).send({
				status: false,
				error: 'invalid_country'
			})
		}
	}

	const result = await Member.findOne({
		where: {
			id: member.id
		},
		include: [{
			model: User,
			attributes: userFields
		}]
	})

	ChatCtrl.notifyNewMember(result)
	// Should announce here

	// Load room again
	room = await Room.findOne({
		where: { id },
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User,
			attributes: userFields
		}]
	})

	res.send({
		status: true,
		data: room
	})
}

const getMessages = async (req, res) => {
	const room = await Room.findOne({ where: { id: req.params.id }})
	if (!room) {
		return res.status(400).send({
			success: false,
			error: 'no_room'
		})
	}

	const { query } = req
	const where = {}
	const limit = parseInt(query.limit || 10)
	const order = query.order || 'createdAt'
	const direction = query.direction || 'ASC'
	const { text } = query

	where.room_id = room.id

	where['createdAt']= {
		[Op.lte]: new Date(query.to || new Date()),
		[Op.gt]: new Date(query.from || new Date(0))
	}

	if (text) {
		where['text'] = {
			[Op.like]: '%' + text + '%'
		}
	}

	const messages = await Message.findAll({ 
		where, 
		limit,
		include: [{ model: Member, include: [{ model: User, attributes: userFields }]}],
		order: [[order, direction]]
	})

	res.send({
		status: true,
		data: messages
	})
}

const report = async (req, res) => {
	const { id } = req.params
	const room = await Room.findOne({ where: { id }})
	if (!room) {
		return res.status(400).send({
			status: false,
			error: 'no_room'
		})
	}
	const { type, description } = req.body

	const roomReport = await new RoomReport({
		user_id: req.currentUser.id,
		room_id: room.id,
		type, 
		description
	}).save()

	res.send({
		status: true,
		data: roomReport
	})
}

const leave = async (req, res) => {
	const { id } = req.params
	const user_id = req.currentUser.id

	let room = await Room.findOne({ where: { id }	})

	// Check room
	if (!room) {
		return res.status(400).send({
			status: false,
			error: 'no_room'
		})
	}

	// Check if owner
	// TODO: should check if admin
	if (room.user_id === req.currentUser.id) {
		return res.status(400).send({
			status: false,
			error: 'creator_not_allowed'
		})
	}

	let member = await Member.findOne({
		where: {
			user_id,
			room_id: room.id
		}
	})

	if (!member) {
		return res.status(400).send({
			status: false,
			error: 'not_member'
		})
	} else if (member.removed) {
		return res.status(400).send({
			status: false,
			error: 'already_left'
		})
	}

	member.removed = true
	await member.save()

	const result = await Member.findOne({
		where: {
			id: member.id,
		},
		include: [{ model: User, attributes: userFields }]
	})

	ChatCtrl.notifyRoomMemberLeft(result)

	res.send({
		status: true,
		data: result
	})
}


const kickMember = async (req, res) => {
	const { id } = req.params
	const { user_id } = req.body

	let room = await Room.findOne({ where: { id }	})

	// Check room
	if (!room) {
		return res.status(400).send({
			status: false,
			error: 'no_room'
		})
	}

	// check user
	const user = await User.findOne({ where: { id: user_id }})
	if (!user) {
		return res.status(400).send({
			status: false,
			error: 'no_user'
		})
	}

	// Check if owner
	// TODO: should check if admin
	if (room.user_id !== req.currentUser.id) {
		console.info('Room Creator:', room.user_id)
		console.info('Current User:', req.currentUser.id)

		return res.status(400).send({
			status: false,
			error: 'no_permission'
		})
	}

	let member = await Member.findOne({
		where: {
			user_id,
			room_id: room.id
		},
		include: [{
			model: User,
			attributes: userFields
		}]
	})

	if (!member) {
		return res.status(400).send({
			status: false,
			error: 'no_member'
		})
	}

	if (member.removed) {
		return res.status(400).send({
			status: false,
			error: 'already_removed'
		})
	}
	member.removed = true
	member = await member.save()

	const result = await Member.findOne({
		where: {
			id: member.id
		},
		include: [{
			model: User,
			attributes: userFields
		}]
	})

	ChatCtrl.notifyRoomMemberLeft(member)
	// Should announce here

	// Load room again
	room = await Room.findOne({
		where: { id },
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }]
		}, {
			model: User,
			attributes: userFields
		}]
	})

	res.send({
		status: true,
		data: room
	})
}

const read = async (req, res) => {
	const { id } = req.params
	const { currentUser } = req

	const room = await Room.findOne({
		where: { id },
		include: [{
			model: Member,
			include: [{ model: User, attributes: userFields }],
			where: {
				user_id: req.currentUser.id
			}
		}, {
			model: User,
			attributes: userFields
		}]
	})

	if (!room) {
		return res.status(400).send({
			status: true,
			error: 'no_room'
		})
	}

  const member = await Member.findOne({
    where: {
      user_id: currentUser.id,
      room_id: room.id
    }
  })

  member.last_read_at = new Date()
  const result = await member.save()

  res.send({
  	status: true,
  	data: {
  		last_read_at: result.last_read_at
  	}
  })
}

const sendMessage = async (req, res) => {
	const data = req.body
	const { currentUser } = req
	const room_id = req.params.id
	const room = await Room.findOne({
    where: { id: room_id },
    include: [{
      model: Member,
      include: [{ model: User, attributes: userFields }],
      where: { user_id: currentUser.id, removed: false }
    }, {
        model: User,
        attributes: userFields
      }]
  })

  if (!room) {
    return {
      status: false,
      error: 'invalid_room'
    }
  }

  const member = await Member.findOne({
    where: {
      user_id: currentUser.id,
      room_id: room.id
    }
  })

  const message = await (new Message({
    member_id: member.id,
    room_id,
    text: data.text,
  })).save()

  const count = await Message.count({
    where: {
      room_id
    }
  })

  const savedMsg = await Message.findOne({
    where: { id: message.id },
    include: [{ model: Member, include: [{ model: User, attributes: userFields }] }]
  })

  const result = savedMsg.get({
    plain: true
  })

  result.room_message_count = await Message.count({
    where: {
      room_id
    }
  })

  res.send({
  	status: true,
  	data: result
  })
}

module.exports = {
	queryMyRooms,
	query,
	get,
	leave,
	edit,
	create,
	addMember,
	kickMember,
	getMessages,
	report,
	join,
	read,
	sendMessage
}
