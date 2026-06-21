package com.academicagent.platform.identity.service;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.identity.entity.User;
import com.academicagent.platform.identity.model.UserProfile;
import com.academicagent.platform.identity.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Transactional(readOnly = true)
    public UserProfile getProfile(String userId) {
        return toProfile(requireUser(userId));
    }

    @Transactional
    public UserProfile updateDisplayName(String userId, String displayName) {
        User user = requireUser(userId);
        user.setDisplayName(displayName);
        userRepository.save(user);
        return toProfile(user);
    }

    @Transactional(readOnly = true)
    public User requireUser(String userId) {
        return userRepository
                .findById(userId)
                .orElseThrow(() -> new ApiException("User not found", HttpStatus.NOT_FOUND, "user_not_found"));
    }

    public UserProfile toProfile(User user) {
        return new UserProfile(user.getUserId(), user.getEmail(), user.getDisplayName(), user.getCreatedAt());
    }
}
