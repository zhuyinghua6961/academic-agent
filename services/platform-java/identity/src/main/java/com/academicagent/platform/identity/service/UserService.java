package com.academicagent.platform.identity.service;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.identity.entity.User;
import com.academicagent.platform.identity.mapper.UserMapper;
import com.academicagent.platform.identity.model.UserProfile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserService {

    private final UserMapper userMapper;

    public UserService(UserMapper userMapper) {
        this.userMapper = userMapper;
    }

    @Transactional(readOnly = true)
    public UserProfile getProfile(String userId) {
        return toProfile(requireUser(userId));
    }

    @Transactional
    public UserProfile updateDisplayName(String userId, String displayName) {
        User user = requireUser(userId);
        user.setDisplayName(displayName);
        userMapper.updateById(user);
        return toProfile(user);
    }

    @Transactional(readOnly = true)
    public User requireUser(String userId) {
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw new ApiException("User not found", HttpStatus.NOT_FOUND, "user_not_found");
        }
        return user;
    }

    public UserProfile toProfile(User user) {
        return new UserProfile(user.getUserId(), user.getEmail(), user.getDisplayName(), user.getCreatedAt());
    }
}
